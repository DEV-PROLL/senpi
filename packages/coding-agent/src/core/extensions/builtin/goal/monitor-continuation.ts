import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { isTerminalMonitorStateEvent, TERMINAL_MONITOR_STATE_EVENT } from "../monitor-state-event.ts";
import { shouldQueueGoalContinuationAfterAgentEnd, shouldQueueGoalContinuationWhenIdle } from "./continuation.ts";
import { queueHiddenGoalPrompt } from "./lifecycle-helpers.ts";
import { buildContinuationPrompt, buildMonitorStallNotice } from "./prompt.ts";
import type { Goal } from "./types.ts";

export const GOAL_MONITOR_CONTINUATION_DELAY_MS = 240_000;
export const GOAL_CONTINUATION_SCHEDULED_EVENT = "goal_continuation_scheduled";
export const GOAL_MONITOR_CONTINUATION_NOTICE = "Goal continuation scheduled in 4 minutes while a monitor is active.";
export const GOAL_MONITOR_STALL_THRESHOLD = 3;
export const GOAL_MONITOR_STALL_EVENT = "goal_monitor_continuation_stall";

interface AgentEndOptions {
	readonly ctx: ExtensionContext;
	readonly goal: Goal | null;
	readonly messages: readonly AgentMessage[];
	readonly aborted: boolean;
}

export class MonitorAwareGoalContinuation {
	readonly #pi: ExtensionAPI;
	#activeMonitorCount = 0;
	#ctx: ExtensionContext | undefined;
	#goal: Goal | null = null;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#unsubscribeMonitorState: (() => void) | undefined;
	#consecutiveMonitorContinuations = 0;
	#stallGoalId: string | null = null;

	constructor(pi: ExtensionAPI) {
		this.#pi = pi;
	}

	start(ctx: ExtensionContext): void {
		this.#cancelTimer();
		this.#unsubscribeMonitorState?.();
		this.#ctx = ctx;
		this.#activeMonitorCount = 0;
		this.#resetStallStreak();
		const events = this.#pi.events;
		if (events === undefined) return;
		this.#unsubscribeMonitorState = events.on(TERMINAL_MONITOR_STATE_EVENT, (data) => {
			if (!isTerminalMonitorStateEvent(data)) return;
			this.#activeMonitorCount = data.activeCount;
			if (data.activeCount === 0) {
				this.#cancelTimer();
				this.#resetStallStreak();
			}
		});
	}

	afterAgentEnd(options: AgentEndOptions): void {
		this.#ctx = options.ctx;
		this.#goal = options.goal;
		if (
			options.aborted ||
			!shouldQueueGoalContinuationAfterAgentEnd(options.goal, options.ctx.hasPendingMessages(), options.messages)
		) {
			return;
		}
		if (this.#activeMonitorCount === 0) {
			this.#cancelTimer();
			this.#resetStallStreak();
			queueHiddenGoalPrompt(this.#pi, buildContinuationPrompt(options.goal));
			return;
		}
		this.#schedule(options.goal);
	}

	syncGoal(goal: Goal | null): void {
		this.#goal = goal;
		if (goal?.status !== "active") {
			this.#cancelTimer();
			this.#resetStallStreak();
		}
	}

	/** A real user prompt breaks the unattended monitor-wait loop; restart the stall count. */
	noteUserPrompt(): void {
		this.#resetStallStreak();
	}

	dispose(): void {
		this.#cancelTimer();
		this.#unsubscribeMonitorState?.();
		this.#unsubscribeMonitorState = undefined;
		this.#ctx = undefined;
		this.#goal = null;
		this.#activeMonitorCount = 0;
		this.#resetStallStreak();
	}

	#schedule(goal: Goal): void {
		if (this.#timer !== undefined) return;
		if (this.#ctx?.hasUI) this.#ctx.ui.notify(GOAL_MONITOR_CONTINUATION_NOTICE, "info");
		this.#pi.events.emit(GOAL_CONTINUATION_SCHEDULED_EVENT, {
			goalId: goal.id,
			delayMs: GOAL_MONITOR_CONTINUATION_DELAY_MS,
			activeMonitorCount: this.#activeMonitorCount,
		});
		this.#timer = setTimeout(() => this.#continueIfEligible(), GOAL_MONITOR_CONTINUATION_DELAY_MS);
	}

	#continueIfEligible(): void {
		this.#timer = undefined;
		const ctx = this.#ctx;
		if (ctx === undefined || this.#activeMonitorCount === 0) return;
		const goal = this.#goal;
		if (shouldQueueGoalContinuationWhenIdle(goal, ctx.isIdle(), ctx.hasPendingMessages())) {
			queueHiddenGoalPrompt(this.#pi, this.#buildMonitorContinuationContent(ctx, goal));
		}
	}

	/** Counts consecutive monitor-wait continuations; from the third one on, prepends an active stall check. */
	#buildMonitorContinuationContent(ctx: ExtensionContext, goal: Goal): string {
		if (goal.id !== this.#stallGoalId) {
			this.#stallGoalId = goal.id;
			this.#consecutiveMonitorContinuations = 0;
		}
		this.#consecutiveMonitorContinuations += 1;
		const content = buildContinuationPrompt(goal);
		if (this.#consecutiveMonitorContinuations < GOAL_MONITOR_STALL_THRESHOLD) return content;
		this.#pi.events.emit(GOAL_MONITOR_STALL_EVENT, {
			goalId: goal.id,
			consecutiveContinuations: this.#consecutiveMonitorContinuations,
		});
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Goal continuation repeated ${this.#consecutiveMonitorContinuations} times while monitors stayed active - injected a stall check.`,
				"info",
			);
		}
		return `${buildMonitorStallNotice(this.#consecutiveMonitorContinuations)}\n\n${content}`;
	}

	#resetStallStreak(): void {
		this.#consecutiveMonitorContinuations = 0;
		this.#stallGoalId = null;
	}

	#cancelTimer(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}
