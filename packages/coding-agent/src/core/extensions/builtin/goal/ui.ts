import type { ExtensionContext } from "../../types.ts";
import { formatGoalElapsedSeconds } from "./format.ts";
import type { Goal } from "./types.ts";

export const STATUS_KEY = "goal";

export function updateGoalUi(ctx: ExtensionContext, goal: Goal | null, liveElapsedSeconds?: number): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, goal === null ? undefined : goalStatusText(goal, liveElapsedSeconds));
}

export function goalStatusText(goal: Goal, liveElapsedSeconds?: number): string {
	switch (goal.status) {
		case "active": {
			if (liveElapsedSeconds !== undefined) {
				return `Pursuing ultragoal (${formatGoalElapsedSeconds(liveElapsedSeconds)})`;
			}
			return goal.timeUsedSeconds > 0
				? `Pursuing ultragoal (${formatGoalElapsedSeconds(goal.timeUsedSeconds)})`
				: "Pursuing ultragoal";
		}
		case "paused":
			return "Ultragoal paused (/ultragoal resume)";
		case "blocked":
			return goal.blockedReason ? `Ultragoal blocked: ${goal.blockedReason}` : "Ultragoal blocked";
		case "complete":
			return "Ultragoal achieved";
	}
}
