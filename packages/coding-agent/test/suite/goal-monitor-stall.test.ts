import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	type GoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "./goal-monitor-test-harness.ts";

const STALL_MARKER = "<goal_monitor_stall_check>";
const STALL_EVENT = "goal_monitor_continuation_stall";

interface StallHarness {
	readonly harness: GoalHarness;
	readonly ctx: ExtensionContext;
	readonly notices: string[];
}

async function createStallHarness(threadId: string): Promise<StallHarness> {
	const notices: string[] = [];
	const harness = createGoalHarness();
	const ctx = await makeGoalContext(notices, threadId);
	await harness.tools
		.get("create_goal")
		?.execute("create", { objective: "Keep monitoring" }, undefined, undefined, ctx);
	await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
	harness.events.emit("terminal_monitor_state", { activeCount: 1 });
	await harness.events.flush();
	return { harness, ctx, notices };
}

async function runMonitorContinuationCycle(harness: GoalHarness, ctx: ExtensionContext): Promise<void> {
	await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
	await runGoalHandlers(harness.handlers, "agent_end", { type: "agent_end", messages: [cleanAssistantStop()] }, ctx);
	await vi.advanceTimersByTimeAsync(240_000);
}

function stallEvents(harness: GoalHarness): unknown[] {
	return harness.events.emitted.filter((event) => event.channel === STALL_EVENT).map((event) => event.data);
}

describe("goal monitor continuation stall check", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("injects the stall check from the third consecutive monitor continuation onward", async () => {
		vi.useFakeTimers();
		const { harness, ctx, notices } = await createStallHarness("thread-stall-threshold");

		await runMonitorContinuationCycle(harness, ctx);
		await runMonitorContinuationCycle(harness, ctx);
		expect(harness.sent).toHaveLength(2);
		expect(harness.sent[0]?.message.content).not.toContain(STALL_MARKER);
		expect(harness.sent[1]?.message.content).not.toContain(STALL_MARKER);
		expect(stallEvents(harness)).toHaveLength(0);

		await runMonitorContinuationCycle(harness, ctx);
		expect(harness.sent).toHaveLength(3);
		expect(harness.sent[2]?.message.content).toContain(STALL_MARKER);
		expect(stallEvents(harness)).toEqual([expect.objectContaining({ consecutiveContinuations: 3 })]);
		expect(notices.some((notice) => /stall/i.test(notice))).toBe(true);

		await runMonitorContinuationCycle(harness, ctx);
		expect(harness.sent[3]?.message.content).toContain(STALL_MARKER);
		expect(stallEvents(harness)).toHaveLength(2);
	});

	it("resets the streak when the monitors settle and a new monitor starts", async () => {
		vi.useFakeTimers();
		const { harness, ctx } = await createStallHarness("thread-stall-settle-reset");

		await runMonitorContinuationCycle(harness, ctx);
		await runMonitorContinuationCycle(harness, ctx);

		harness.events.emit("terminal_monitor_state", { activeCount: 0 });
		await harness.events.flush();
		harness.events.emit("terminal_monitor_state", { activeCount: 1 });
		await harness.events.flush();

		await runMonitorContinuationCycle(harness, ctx);
		expect(harness.sent).toHaveLength(3);
		expect(harness.sent[2]?.message.content).not.toContain(STALL_MARKER);
		expect(stallEvents(harness)).toHaveLength(0);
	});

	it("resets the streak when a real user prompt starts a turn", async () => {
		vi.useFakeTimers();
		const { harness, ctx } = await createStallHarness("thread-stall-user-reset");

		await runMonitorContinuationCycle(harness, ctx);
		await runMonitorContinuationCycle(harness, ctx);

		await runGoalHandlers(harness.handlers, "before_agent_start", { type: "before_agent_start" }, ctx);

		await runMonitorContinuationCycle(harness, ctx);
		expect(harness.sent).toHaveLength(3);
		expect(harness.sent[2]?.message.content).not.toContain(STALL_MARKER);
		expect(stallEvents(harness)).toHaveLength(0);
	});

	it("does not carry the streak across a completed goal into its replacement", async () => {
		vi.useFakeTimers();
		const { harness, ctx } = await createStallHarness("thread-stall-goal-reset");

		await runMonitorContinuationCycle(harness, ctx);
		await runMonitorContinuationCycle(harness, ctx);

		await harness.tools.get("update_goal")?.execute("complete", { status: "complete" }, undefined, undefined, ctx);
		await harness.tools
			.get("create_goal")
			?.execute("create", { objective: "Fresh objective" }, undefined, undefined, ctx);

		const sentBefore = harness.sent.length;
		await runMonitorContinuationCycle(harness, ctx);
		const sentAfter = harness.sent.slice(sentBefore);
		expect(sentAfter.length).toBeGreaterThan(0);
		for (const sent of sentAfter) {
			expect(sent.message.content).not.toContain(STALL_MARKER);
		}
		expect(stallEvents(harness)).toHaveLength(0);
	});
});
