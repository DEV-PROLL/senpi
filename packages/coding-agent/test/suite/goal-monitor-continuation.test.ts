import { watch } from "node:fs";
import { join } from "node:path";
import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from "node:timers";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOAL_USER_GRACE_DELAY_MS } from "../../src/core/extensions/builtin/goal/continuation.ts";
import { admitAndQueueGoalContinuation } from "../../src/core/extensions/builtin/goal/lifecycle-helpers.ts";
import {
	GOAL_MONITOR_CONTINUATION_DELAY_MS,
	MonitorAwareGoalContinuation,
} from "../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { readGoal, recordContinuationDelivered, updateGoal, writeGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	type GoalHandler,
	TestEventBus,
	makeGoalContext,
	runGoalHandlers,
} from "./goal-monitor-test-harness.ts";

function goalStoreRef(ctx: ExtensionContext) {
	return {
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function waitForGoalContinuationCount(ctx: ExtensionContext, expectedCount: number): Promise<void> {
	const ref = goalStoreRef(ctx);
	const goalFileName = `${encodeURIComponent(ref.threadId)}.json`;
	return new Promise((resolve, reject) => {
		let completed = false;
		let timeout: ReturnType<typeof setRealTimeout> | undefined;
		const watcher = watch(ref.baseDir, { encoding: "utf8" }, (_eventType, changedFileName) => {
			if (changedFileName !== goalFileName) return;
			void readGoal(ref).then((goal) => {
				if (goal?.consecutiveContinuations === expectedCount) complete();
			}, complete);
		});
		timeout = setRealTimeout(
			() => complete(new Error(`Timed out waiting for continuation count ${expectedCount}`)),
			5_000,
		);
		watcher.once("error", complete);

		function complete(error: Error | undefined = undefined): void {
			if (completed) return;
			completed = true;
			if (timeout !== undefined) clearRealTimeout(timeout);
			watcher.close();
			if (error === undefined) resolve();
			else reject(error);
		}
	});
}

function cleanAssistantStopWithText(text: string): AgentMessage {
	return assistantStopWithReason("stop", text);
}

function assistantStopWithReason(stopReason: "stop" | "length", text: string): AgentMessage {
	const message = cleanAssistantStop();
	if (message.role !== "assistant") throw new Error("Expected assistant stop message");
	return { ...message, content: [{ type: "text", text }], stopReason };
}

function activeGoal(id: string): Goal {
	return {
		id,
		threadId: `${id}-thread`,
		objective: "Keep moving",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
	};
}

function createDirectMonitorHarness(): { monitor: MonitorAwareGoalContinuation; sent: string[]; events: TestEventBus } {
	const sent: string[] = [];
	const events = new TestEventBus();
	const pi = {
		sendMessage: (message: { readonly content: string }) => sent.push(message.content),
		events,
	} as unknown as ExtensionAPI;
	return { monitor: new MonitorAwareGoalContinuation(pi), sent, events };
}

async function runUserInitiatedTurn(handlers: Map<string, GoalHandler[]>, ctx: ExtensionContext): Promise<void> {
	await runGoalHandlers(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
	await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
	await runGoalHandlers(handlers, "agent_end", { type: "agent_end", messages: [cleanAssistantStop()] }, ctx);
}

describe("goal continuation while a monitor is active", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("waits four minutes before continuing and announces the schedule", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-monitor-cadence");
		await tools.get("create_goal")?.execute("create", { objective: "Keep watching" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		events.emit("terminal_monitor_state", { activeCount: 1 });
		await events.flush();

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(handlers, "agent_end", { type: "agent_end", messages: [cleanAssistantStop()] }, ctx);

		expect(sent).toHaveLength(0);
		expect(notices).toEqual([expect.stringMatching(/4 minutes/i)]);
		expect(events.emitted).toContainEqual({
			channel: "goal_continuation_scheduled",
			data: expect.objectContaining({ delayMs: 240_000 }),
		});

		await vi.advanceTimersByTimeAsync(239_999);
		expect(sent).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
	});

	it("continues immediately after a clean continuation turn when no monitor is active", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-no-monitor");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(handlers, "agent_end", { type: "agent_end", messages: [cleanAssistantStop()] }, ctx);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
		expect(notices).toHaveLength(0);
	});

	it("counts user grace delivery toward the continuation cap", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-user-grace-counted");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runUserInitiatedTurn(handlers, ctx);
		expect(sent).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(GOAL_USER_GRACE_DELAY_MS - 1);
		expect(sent).toHaveLength(0);
		const graceDeliveryRecorded = waitForGoalContinuationCount(ctx, 1);
		await vi.advanceTimersByTimeAsync(1);
		await graceDeliveryRecorded;
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ consecutiveContinuations: 1 });

		for (let turn = 2; turn <= 8; turn++) {
			await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
			await runGoalHandlers(
				handlers,
				"agent_end",
				{ type: "agent_end", messages: [cleanAssistantStopWithText(`progress ${turn}`)] },
				ctx,
			);
		}

		expect(sent).toHaveLength(8);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active", consecutiveContinuations: 8 });

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStopWithText("progress 9")] },
			ctx,
		);

		expect(sent).toHaveLength(8);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "continuation cap reached",
		});
		expect(events.emitted).toContainEqual({
			channel: "goal_continuation_guard_tripped",
			data: expect.objectContaining({ reason: "cap", count: 8 }),
		});
	});

	it("continues after user grace even when an active monitor settles", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-user-grace-monitor-settles");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
		events.emit("terminal_monitor_state", { activeCount: 1 });
		await events.flush();

		await runUserInitiatedTurn(handlers, ctx);
		events.emit("terminal_monitor_state", { activeCount: 0 });
		await events.flush();
		const graceDeliveryRecorded = waitForGoalContinuationCount(ctx, 1);
		await vi.advanceTimersByTimeAsync(GOAL_USER_GRACE_DELAY_MS);
		await graceDeliveryRecorded;

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
	});

	it("cancels a pending user grace continuation when another user prompt arrives", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-user-grace-prompt-cancel");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runUserInitiatedTurn(handlers, ctx);
		await vi.advanceTimersByTimeAsync(30_000);
		await runGoalHandlers(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
		await vi.advanceTimersByTimeAsync(GOAL_USER_GRACE_DELAY_MS);

		expect(sent).toHaveLength(0);
	});

	it.each([
		"paused",
		"complete",
	] as const)("cancels a pending user grace continuation when the goal becomes %s", async (status) => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, `thread-user-grace-${status}-cancel`);
		const { monitor, sent } = createDirectMonitorHarness();
		const goal = activeGoal(`goal-user-grace-${status}`);
		monitor.start(ctx);
		monitor.noteUserPrompt();
		await monitor.afterAgentEnd({ ctx, goal, messages: [cleanAssistantStop()] });

		await vi.advanceTimersByTimeAsync(45_000);
		monitor.syncGoal({ ...goal, status });
		await vi.advanceTimersByTimeAsync(GOAL_USER_GRACE_DELAY_MS);

		expect(sent).toHaveLength(0);
	});

	it("does not continue a pending user grace turn after pending messages arrive", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const state = { pendingMessages: false };
		const ctx = await makeGoalContext(notices, "thread-user-grace-pending-cancel", state);
		const { monitor, sent } = createDirectMonitorHarness();
		const goal = activeGoal("goal-user-grace-pending-cancel");
		monitor.start(ctx);
		monitor.noteUserPrompt();
		await monitor.afterAgentEnd({ ctx, goal, messages: [cleanAssistantStop()] });

		await vi.advanceTimersByTimeAsync(45_000);
		state.pendingMessages = true;
		await vi.advanceTimersByTimeAsync(GOAL_USER_GRACE_DELAY_MS - 45_000);

		expect(sent).toHaveLength(0);
	});

	it("resets monitor-delayed repetition state when a goal pauses and resumes", async () => {
		vi.useFakeTimers();
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-monitor-repetition-resume");
		const { monitor, sent, events } = createDirectMonitorHarness();
		const goal = activeGoal("goal-monitor-repetition-resume");
		await writeGoal(goalStoreRef(ctx), goal);
		monitor.start(ctx);
		events.emit("terminal_monitor_state", { activeCount: 1 });
		await events.flush();

		for (let turn = 1; turn <= 2; turn++) {
			await monitor.afterAgentEnd({
				ctx,
				goal,
				messages: [cleanAssistantStopWithText("unchanged monitor output")],
			});
			await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_DELAY_MS);
		}

		const paused = await updateGoal(goalStoreRef(ctx), { status: "paused" }, "user");
		monitor.syncGoal(paused);
		const resumed = await updateGoal(goalStoreRef(ctx), { status: "active" }, "user");
		monitor.syncGoal(resumed);
		await monitor.afterAgentEnd({
			ctx,
			goal: resumed,
			messages: [cleanAssistantStopWithText("unchanged monitor output")],
		});
		await vi.advanceTimersByTimeAsync(GOAL_MONITOR_CONTINUATION_DELAY_MS);

		expect(sent).toHaveLength(3);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });
	});

	it("resets truncation recovery state when a goal pauses and resumes", async () => {
		const notices: string[] = [];
		const ctx = await makeGoalContext(notices, "thread-length-resume");
		const { monitor, sent } = createDirectMonitorHarness();
		const goal = activeGoal("goal-length-resume");
		await writeGoal(goalStoreRef(ctx), goal);
		monitor.start(ctx);

		await monitor.afterAgentEnd({
			ctx,
			goal,
			messages: [assistantStopWithReason("length", "first unfinished implementation")],
		});
		expect(sent).toHaveLength(1);

		const paused = await updateGoal(goalStoreRef(ctx), { status: "paused" }, "user");
		monitor.syncGoal(paused);
		const resumed = await updateGoal(goalStoreRef(ctx), { status: "active" }, "user");
		monitor.syncGoal(resumed);
		await monitor.afterAgentEnd({
			ctx,
			goal: resumed,
			messages: [assistantStopWithReason("length", "second unfinished implementation")],
		});

		expect(sent).toHaveLength(2);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });
	});

	it("queues one minimal recovery prompt after an output truncation", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-length-minimal");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantStopWithReason("length", "unfinished implementation")] },
			ctx,
		);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("goal-continuation");
		expect(sent[0]?.message.content).toContain("cut off");
		expect(sent[0]?.message.content).not.toContain("<untrusted_objective>");
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active", consecutiveContinuations: 1 });
	});

	it("blocks a second consecutive output truncation without queuing another prompt", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-length-exhausted");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantStopWithReason("length", "first unfinished implementation")] },
			ctx,
		);
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantStopWithReason("length", "second unfinished implementation")] },
			ctx,
		);

		expect(sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "output truncation repeated",
		});
		expect(events.emitted).toContainEqual({
			channel: "goal_continuation_guard_tripped",
			data: expect.objectContaining({ reason: "length-exhausted" }),
		});
	});

	it("resets truncation recovery after a clean stop", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-length-reset");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantStopWithReason("length", "first unfinished implementation")] },
			ctx,
		);
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStopWithText("completed a clean step")] },
			ctx,
		);
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantStopWithReason("length", "second unfinished implementation")] },
			ctx,
		);

		expect(sent).toHaveLength(3);
		expect(sent[2]?.message.content).toContain("cut off");
		expect(sent[2]?.message.content).not.toContain("<untrusted_objective>");
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active" });

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [assistantStopWithReason("length", "third unfinished implementation")] },
			ctx,
		);

		expect(sent).toHaveLength(3);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "output truncation repeated",
		});
	});

	it("blocks the ninth clean immediate continuation without queuing a ninth hidden prompt", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-immediate-cap");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		for (let turn = 1; turn <= 8; turn++) {
			await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
			await runGoalHandlers(
				handlers,
				"agent_end",
				{ type: "agent_end", messages: [cleanAssistantStopWithText(`progress ${turn}`)] },
				ctx,
			);
		}

		expect(sent).toHaveLength(8);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active", consecutiveContinuations: 8 });

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStopWithText("progress 9")] },
			ctx,
		);

		expect(sent).toHaveLength(8);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "continuation cap reached",
		});
		expect(events.emitted).toContainEqual({
			channel: "goal_continuation_guard_tripped",
			data: expect.objectContaining({ reason: "cap", count: 8 }),
		});
	});

	it("silently skips a stale continuation after two real agent_end cycles with unchanged progress", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-stale-real-cycles");
		await tools.get("create_goal")?.execute("create", { objective: "Keep moving" }, undefined, undefined, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);

		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStopWithText("No progress yet")] },
			ctx,
		);
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			handlers,
			"agent_end",
			{ type: "agent_end", messages: [cleanAssistantStopWithText("No progress yet")] },
			ctx,
		);

		expect(sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active", consecutiveContinuations: 1 });
		expect(events.emitted).not.toContainEqual(
			expect.objectContaining({ channel: "goal_continuation_guard_tripped" }),
		);
	});

	it("counts session_start deliveries and applies the persisted cap on a later session_start", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent, events } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-session-start-cap");
		await tools.get("create_goal")?.execute("create", { objective: "Resume work" }, undefined, undefined, ctx);

		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ consecutiveContinuations: 1 });

		const goal = await readGoal(goalStoreRef(ctx));
		if (goal === null) throw new Error("Expected persisted goal");
		for (let count = 2; count <= 8; count++) {
			await recordContinuationDelivered(goalStoreRef(ctx), `${goal.id}:0/0:seed-${count}`);
		}
		await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "resume" }, ctx);

		expect(sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({
			status: "blocked",
			blockedReason: "continuation cap reached",
			consecutiveContinuations: 0,
		});
		expect(events.emitted).toContainEqual({
			channel: "goal_continuation_guard_tripped",
			data: expect.objectContaining({ reason: "cap", count: 8 }),
		});
	});

	it("does not queue a second session_start continuation while the first is pending", async () => {
		const notices: string[] = [];
		const { tools, handlers, sent } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-single-flight");
		await tools.get("create_goal")?.execute("create", { objective: "Resume once" }, undefined, undefined, ctx);

		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "resume" }, ctx);

		expect(sent).toHaveLength(1);
		expect(await readGoal(goalStoreRef(ctx))).toMatchObject({ status: "active", consecutiveContinuations: 1 });
	});

	it("delivers an unsigned immediate continuation without recording its streak", async () => {
		const notices: string[] = [];
		const { tools } = createGoalHarness();
		const ctx = await makeGoalContext(notices, "thread-unsigned-continuation");
		await tools
			.get("create_goal")
			?.execute("create", { objective: "Continue without a signature" }, undefined, undefined, ctx);
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal === null) throw new Error("Expected persisted goal");

		let continuationMarked = false;
		const result = await admitAndQueueGoalContinuation(
			{ sendMessage: () => {} } as unknown as ExtensionAPI,
			ctx,
			goal,
			{
				input: {
					isIdle: true,
					hasPendingMessages: false,
					path: "immediate",
					lastStopReason: "stop",
					consecutiveContinuations: goal.consecutiveContinuations ?? 0,
					lastContinuationSignature: goal.lastContinuationSignature,
					currentSignature: undefined,
					consecutiveLengthRecoveries: 0,
					recentNormalizedOutputHashes: [],
					toollessContinuationStreak: 0,
					endedTurnWasUserInitiated: false,
					continuationPending: false,
				},
				content: () => "Continue",
				markContinuationPending: () => {
					continuationMarked = true;
				},
			},
		);

		expect(continuationMarked).toBe(true);
		expect(result.consecutiveContinuations ?? 0).toBe(0);
		expect(result.lastContinuationSignature).toBeUndefined();
		expect((await readGoal(goalStoreRef(ctx)))?.consecutiveContinuations ?? 0).toBe(0);
	});
});
