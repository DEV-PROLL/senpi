import { afterEach, describe, expect, it, vi } from "vitest";
import { readGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "./goal-monitor-test-harness.ts";

describe("goal state after a system-owned abort", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it.each(["aborted", "error"] as const)(
		"keeps the Goal active and monitor wait armed after a terminal %s system abort",
		async (stopReason) => {
			vi.useFakeTimers();
			const notices: string[] = [];
			const harness = createGoalHarness();
			const { tools, handlers, sent, events } = harness;
			const ctx = await makeGoalContext(notices, "thread-system-abort-monitor");
			await tools.get("create_goal")?.execute("create", { objective: "Keep watching" }, undefined, undefined, ctx);
			await runGoalHandlers(handlers, "session_start", { type: "session_start", reason: "reload" }, ctx);
			events.emit("terminal_monitor_state", { activeCount: 1 });
			await events.flush();
			await runGoalHandlers(handlers, "agent_start", { type: "agent_start" }, ctx);

			await runGoalHandlers(
				handlers,
				"agent_end",
				{
					type: "agent_end",
					aborted: true,
					abortSource: "system",
					willRetry: false,
					messages: [{ ...cleanAssistantStop(), stopReason }],
				},
				ctx,
			);

			expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({ status: "active" });
			expect(sent).toHaveLength(0);
			expect(events.emitted).toContainEqual({
				channel: "goal_continuation_scheduled",
				data: expect.objectContaining({ activeMonitorCount: 1, delayMs: 240_000 }),
			});
		},
	);
});
