import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "./goal-monitor-test-harness.ts";

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
});
