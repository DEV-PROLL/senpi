import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { isTerminalMonitorStateEvent, TERMINAL_MONITOR_STATE_EVENT } from "../monitor-state-event.ts";
import {
	buildCacheWarmResumedNotice,
	buildCacheWarmScheduledNotice,
	estimateCacheWarmMetrics,
	GOAL_CACHE_WARMUP_ENTRY_TYPE,
	type GoalCacheWarmMetrics,
	type GoalCacheWarmupEntryData,
} from "./cache-warm.ts";
import { shouldQueueGoalContinuationAfterAgentEnd, shouldQueueGoalContinuationWhenIdle } from "./continuation.ts";
import { queueHiddenGoalPrompt } from "./lifecycle-helpers.ts";
import { buildContinuationPrompt, buildMonitorStallNotice } from "./prompt.ts";
import { collectAssistantUsage } from "./turn-usage.ts";
import type { Goal, TokenUsageSnapshot } from "./types.ts";

export const GOAL_MONITOR_CONTINUATION_DELAY_MS = 240_000;
export const GOAL_CONTINUATION_SCHEDULED_EVENT = "goal_continuation_scheduled";
export const GOAL_CONTINUATION_RESUMED_EVENT = "goal_continuation_resumed";
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
	#lastTurnUsage: TokenUsageSnapshot | undefined;
	#scheduledAtMs: number | undefined;
	#scheduledCache: GoalCacheWarmMetrics | undefined;

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
		this.#lastTurnUsage = collectAssistantUsage([...options.messages]);
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
		const cache = estimateCacheWarmMetrics(this.#ctx?.model, process.env, this.#lastTurnUsage);
		this.#scheduledCache = cache;
		this.#scheduledAtMs = Date.now();
		if (this.#ctx?.hasUI) {
			this.#ctx.ui.notify(
				buildCacheWarmScheduledNotice(GOAL_MONITOR_CONTINUATION_DELAY_MS, this.#activeMonitorCount, cache),
				"info",
			);
		}
		this.#pi.events.emit(GOAL_CONTINUATION_SCHEDULED_EVENT, {
			goalId: goal.id,
			delayMs: GOAL_MONITOR_CONTINUATION_DELAY_MS,
			activeMonitorCount: this.#activeMonitorCount,
			cache,
		});
		this.#appendWarmupEntry({
			phase: "scheduled",
			goalId: goal.id,
			delayMs: GOAL_MONITOR_CONTINUATION_DELAY_MS,
			activeMonitorCount: this.#activeMonitorCount,
			...(cache !== undefined ? { cache } : {}),
		});
		this.#timer = setTimeout(() => this.#continueIfEligible(), GOAL_MONITOR_CONTINUATION_DELAY_MS);
	}

	#continueIfEligible(): void {
		this.#timer = undefined;
		const ctx = this.#ctx;
		const waitedMs =
			this.#scheduledAtMs === undefined
				? GOAL_MONITOR_CONTINUATION_DELAY_MS
				: Math.max(0, Date.now() - this.#scheduledAtMs);
		const cache = this.#scheduledCache;
		this.#scheduledAtMs = undefined;
		this.#scheduledCache = undefined;
		if (ctx === undefined || this.#activeMonitorCount === 0) return;
		const goal = this.#goal;
		if (!shouldQueueGoalContinuationWhenIdle(goal, ctx.isIdle(), ctx.hasPendingMessages())) return;
		queueHiddenGoalPrompt(this.#pi, this.#buildMonitorContinuationContent(ctx, goal));
		this.#pi.events.emit(GOAL_CONTINUATION_RESUMED_EVENT, {
			goalId: goal.id,
			delayMs: GOAL_MONITOR_CONTINUATION_DELAY_MS,
			waitedMs,
			activeMonitorCount: this.#activeMonitorCount,
			cache,
		});
		this.#appendWarmupEntry({
			phase: "resumed",
			goalId: goal.id,
			delayMs: GOAL_MONITOR_CONTINUATION_DELAY_MS,
			waitedMs,
			activeMonitorCount: this.#activeMonitorCount,
			...(cache !== undefined ? { cache } : {}),
		});
		if (ctx.hasUI) {
			ctx.ui.notify(buildCacheWarmResumedNotice(waitedMs, this.#activeMonitorCount, cache), "info");
		}
	}

	#appendWarmupEntry(data: GoalCacheWarmupEntryData): void {
		this.#pi.appendEntry<GoalCacheWarmupEntryData>(GOAL_CACHE_WARMUP_ENTRY_TYPE, data);
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
		this.#scheduledAtMs = undefined;
		this.#scheduledCache = undefined;
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}
