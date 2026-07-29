import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readGoal, recordContinuationDelivered } from "../../src/core/extensions/builtin/goal/store.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "./goal-monitor-test-harness.ts";

function goalStoreRef(ctx: ExtensionContext) {
	return {
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "goal"),
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function cleanAssistantStopWithText(text: string): AgentMessage {
	const message = cleanAssistantStop();
	if (message.role !== "assistant") throw new Error("Expected assistant stop message");
	return { ...message, content: [{ type: "text", text }] };
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

	it("continues immediately after a clean turn when no monitor is active", async () => {
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
});
