import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { isTerminalMonitorStateEvent, TERMINAL_MONITOR_STATE_EVENT } from "../monitor-state-event.ts";
import {
	evaluateGoalContinuation,
	hashAssistantText,
	normalizeAssistantText,
	type GoalContinuationInput,
	type GoalContinuationPath,
	type GoalContinuationVerdict,
} from "./continuation.ts";
import {
	admitAndQueueGoalContinuation,
	buildCurrentGoalContinuationSignature,
	lastAssistantText,
} from "./lifecycle-helpers.ts";
import { buildContinuationPrompt, buildGoalStallNotice, buildMonitorStallNotice, buildTruncationRecoveryPrompt } from "./prompt.ts";
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
}

type ContinuingGoalContinuationVerdict = Extract<GoalContinuationVerdict, { kind: "continue" }>;

export class MonitorAwareGoalContinuation {
	readonly #pi: ExtensionAPI;
	readonly #isContinuationPending: () => boolean;
	readonly #markContinuationPending: () => void;
	#activeMonitorCount = 0;
	#ctx: ExtensionContext | undefined;
	#goal: Goal | null = null;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#unsubscribeMonitorState: (() => void) | undefined;
	#lastAgentEndMessages: readonly AgentMessage[] = [];
	#consecutiveMonitorContinuations = 0;
	#stallGoalId: string | null = null;
	#consecutiveLengthRecoveries = 0;
	#recentNormalizedOutputHashes: string[] = [];
	#toollessContinuationStreak = 0;
	#endedTurnWasUserInitiated = false;

	constructor(
		pi: ExtensionAPI,
		isContinuationPending: () => boolean = () => false,
		markContinuationPending: () => void = () => {},
	) {
		this.#pi = pi;
		this.#isContinuationPending = isContinuationPending;
		this.#markContinuationPending = markContinuationPending;
	}

	start(ctx: ExtensionContext): void {
		this.#cancelTimer();
		this.#unsubscribeMonitorState?.();
		this.#ctx = ctx;
		this.#activeMonitorCount = 0;
		this.#lastAgentEndMessages = [];
		this.#resetContinuationState();
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

	async afterAgentEnd(options: AgentEndOptions): Promise<Goal | null> {
		this.#ctx = options.ctx;
		this.#goal = options.goal;
		this.#lastAgentEndMessages = options.messages;
		this.#recordAssistantOutput(options.messages);
		if (options.goal === null) return options.goal;

		const immediateInput = this.#buildVerdictInput(options.ctx, options.goal, "immediate", options.messages);
		const immediateVerdict = evaluateGoalContinuation({ goal: options.goal, ...immediateInput });
		if (immediateVerdict.kind === "deny" && immediateVerdict.reason === "not-eligible") return options.goal;

		if (this.#activeMonitorCount === 0) {
			this.#cancelTimer();
			this.#resetStallStreak();
			return this.#admitAndQueue(options.ctx, options.goal, "immediate", options.messages);
		}
		this.#schedule(options.goal);
		return options.goal;
	}

	syncGoal(goal: Goal | null): void {
		this.#goal = goal;
		if (goal?.status !== "active") {
			this.#cancelTimer();
			this.#resetStallStreak();
		}
	}

	/** A real user prompt breaks unattended continuation state before its agent turn begins. */
	noteUserPrompt(): void {
		this.#endedTurnWasUserInitiated = true;
		this.#resetContinuationState();
		this.#resetStallStreak();
	}

	/** A queued hidden continuation has started, so the next end is not user-initiated. */
	noteContinuationStarted(): void {
		this.#endedTurnWasUserInitiated = false;
	}

	dispose(): void {
		this.#cancelTimer();
		this.#unsubscribeMonitorState?.();
		this.#unsubscribeMonitorState = undefined;
		this.#ctx = undefined;
		this.#goal = null;
		this.#activeMonitorCount = 0;
		this.#lastAgentEndMessages = [];
		this.#resetContinuationState();
		this.#resetStallStreak();
	}

	#schedule(goal: Goal): void {
		if (this.#timer !== undefined) return;
		if (this.#ctx?.hasUI) this.#ctx.ui.notify(GOAL_MONITOR_CONTINUATION_NOTICE, "info");
		this.#pi.events?.emit(GOAL_CONTINUATION_SCHEDULED_EVENT, {
			goalId: goal.id,
			delayMs: GOAL_MONITOR_CONTINUATION_DELAY_MS,
			activeMonitorCount: this.#activeMonitorCount,
		});
		this.#timer = setTimeout(() => void this.#continueIfEligible(), GOAL_MONITOR_CONTINUATION_DELAY_MS);
	}

	async #continueIfEligible(): Promise<void> {
		this.#timer = undefined;
		const ctx = this.#ctx;
		const goal = this.#goal;
		if (ctx === undefined || goal === null || this.#activeMonitorCount === 0) return;
		await this.#admitAndQueue(ctx, goal, "monitorDelayed", this.#lastAgentEndMessages);
	}

	async #admitAndQueue(
		ctx: ExtensionContext,
		goal: Goal,
		path: GoalContinuationPath,
		messages: readonly AgentMessage[],
	): Promise<Goal> {
		const admittedGoal = await admitAndQueueGoalContinuation(this.#pi, ctx, goal, {
			input: this.#buildVerdictInput(ctx, goal, path, messages),
			content: (verdict) => this.#buildContinuationContent(ctx, goal, path, verdict),
			markContinuationPending: this.#markContinuationPending,
		});
		this.#goal = admittedGoal;
		if (admittedGoal.status !== "active") {
			this.#cancelTimer();
			this.#resetStallStreak();
		}
		return admittedGoal;
	}

	#buildVerdictInput(
		ctx: ExtensionContext,
		goal: Goal,
		path: GoalContinuationPath,
		messages: readonly AgentMessage[],
	): Omit<GoalContinuationInput, "goal"> {
		const lastAssistant = findLastAssistantMessage(messages);
		return {
			isIdle: ctx.isIdle(),
			hasPendingMessages: ctx.hasPendingMessages(),
			path,
			lastStopReason: lastAssistant?.stopReason,
			consecutiveContinuations: goal.consecutiveContinuations ?? 0,
			lastContinuationSignature: goal.lastContinuationSignature,
			currentSignature: buildCurrentGoalContinuationSignature(ctx, goal, lastAssistantText(messages)),
			consecutiveLengthRecoveries: this.#consecutiveLengthRecoveries,
			recentNormalizedOutputHashes: this.#recentNormalizedOutputHashes,
			toollessContinuationStreak: this.#toollessContinuationStreak,
			endedTurnWasUserInitiated: this.#endedTurnWasUserInitiated,
			continuationPending: this.#isContinuationPending(),
		};
	}

	#buildContinuationContent(
		ctx: ExtensionContext,
		goal: Goal,
		path: GoalContinuationPath,
		verdict: ContinuingGoalContinuationVerdict,
	): string {
		let content = verdict.prompt === "minimal" ? buildTruncationRecoveryPrompt() : buildContinuationPrompt(goal);
		if (verdict.stallNotice) {
			content = `${buildGoalStallNotice(this.#toollessContinuationStreak, {
				monitorsActive: this.#activeMonitorCount > 0,
			})}\n\n${content}`;
		}
		return path === "monitorDelayed" ? this.#buildMonitorContinuationContent(ctx, goal, content) : content;
	}

	/** Counts consecutive monitor-wait continuations; from the third one on, prepends an active stall check. */
	#buildMonitorContinuationContent(ctx: ExtensionContext, goal: Goal, content: string): string {
		if (goal.id !== this.#stallGoalId) {
			this.#stallGoalId = goal.id;
			this.#consecutiveMonitorContinuations = 0;
		}
		this.#consecutiveMonitorContinuations += 1;
		if (this.#consecutiveMonitorContinuations < GOAL_MONITOR_STALL_THRESHOLD) return content;
		this.#pi.events?.emit(GOAL_MONITOR_STALL_EVENT, {
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

	#recordAssistantOutput(messages: readonly AgentMessage[]): void {
		const text = lastAssistantText(messages);
		if (normalizeAssistantText(text).length === 0) return;
		this.#recentNormalizedOutputHashes = [...this.#recentNormalizedOutputHashes, hashAssistantText(text)].slice(-3);
	}

	#resetContinuationState(): void {
		this.#consecutiveLengthRecoveries = 0;
		this.#recentNormalizedOutputHashes = [];
		this.#toollessContinuationStreak = 0;
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

function findLastAssistantMessage(
	messages: readonly AgentMessage[],
): Extract<AgentMessage, { role: "assistant" }> | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") return message;
	}
	return undefined;
}
