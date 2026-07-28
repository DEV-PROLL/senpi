import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { isTerminalMonitorStateEvent, TERMINAL_MONITOR_STATE_EVENT } from "../monitor-state-event.ts";
import { shouldQueueGoalContinuationAfterAgentEnd, shouldQueueGoalContinuationWhenIdle } from "./continuation.ts";
import { queueHiddenGoalPrompt } from "./lifecycle-helpers.ts";
import { buildContinuationPrompt } from "./prompt.ts";
import type { Goal } from "./types.ts";

export const GOAL_MONITOR_CONTINUATION_DELAY_MS = 240_000;
export const GOAL_CONTINUATION_SCHEDULED_EVENT = "goal_continuation_scheduled";
export const GOAL_MONITOR_CONTINUATION_NOTICE = "Goal continuation scheduled in 4 minutes while a monitor is active.";

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

	constructor(pi: ExtensionAPI) {
		this.#pi = pi;
	}

	start(ctx: ExtensionContext): void {
		this.#cancelTimer();
		this.#unsubscribeMonitorState?.();
		this.#ctx = ctx;
		this.#activeMonitorCount = 0;
		const events = this.#pi.events;
		if (events === undefined) return;
		this.#unsubscribeMonitorState = events.on(TERMINAL_MONITOR_STATE_EVENT, (data) => {
			if (!isTerminalMonitorStateEvent(data)) return;
			this.#activeMonitorCount = data.activeCount;
			if (data.activeCount === 0) this.#cancelTimer();
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
			queueHiddenGoalPrompt(this.#pi, buildContinuationPrompt(options.goal));
			return;
		}
		this.#schedule(options.goal);
	}

	syncGoal(goal: Goal | null): void {
		this.#goal = goal;
		if (goal?.status !== "active") this.#cancelTimer();
	}

	dispose(): void {
		this.#cancelTimer();
		this.#unsubscribeMonitorState?.();
		this.#unsubscribeMonitorState = undefined;
		this.#ctx = undefined;
		this.#goal = null;
		this.#activeMonitorCount = 0;
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
			queueHiddenGoalPrompt(this.#pi, buildContinuationPrompt(goal));
		}
	}

	#cancelTimer(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}
