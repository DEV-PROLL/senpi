import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { isTerminalMonitorStateEvent, TERMINAL_MONITOR_STATE_EVENT } from "../monitor-state-event.ts";
import {
	evaluateGoalContinuation,
	GOAL_USER_GRACE_DELAY_MS,
	type GoalContinuationInput,
	type GoalContinuationPath,
	type GoalContinuationVerdict,
	hashAssistantText,
	normalizeAssistantText,
} from "./continuation.ts";
import {
	admitAndQueueGoalContinuation,
	buildCurrentGoalContinuationSignature,
	lastAssistantText,
} from "./lifecycle-helpers.ts";
import { buildContinuationPrompt, buildGoalStallNotice, buildTruncationRecoveryPrompt } from "./prompt.ts";
import type { Goal } from "./types.ts";

export const GOAL_MONITOR_CONTINUATION_DELAY_MS = 240_000;
export const GOAL_CONTINUATION_SCHEDULED_EVENT = "goal_continuation_scheduled";
export const GOAL_MONITOR_CONTINUATION_NOTICE = "Goal continuation scheduled in 4 minutes while a monitor is active.";
export const GOAL_MONITOR_STALL_EVENT = "goal_monitor_continuation_stall";

interface AgentEndOptions {
	readonly ctx: ExtensionContext;
	readonly goal: Goal | null;
	readonly messages: readonly AgentMessage[];
}

type ContinuingGoalContinuationVerdict = Extract<GoalContinuationVerdict, { kind: "continue" }>;
type DelayedContinuationKind = "monitor" | "userGrace";

export class MonitorAwareGoalContinuation {
	readonly #pi: ExtensionAPI;
	readonly #isContinuationPending: () => boolean;
	readonly #markContinuationPending: () => void;
	#activeMonitorCount = 0;
	#ctx: ExtensionContext | undefined;
	#goal: Goal | null = null;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#scheduledContinuationKind: DelayedContinuationKind | undefined;
	#unsubscribeMonitorState: (() => void) | undefined;
	#lastAgentEndMessages: readonly AgentMessage[] = [];
	#consecutiveLengthRecoveries = new Map<string, number>();
	#recentNormalizedOutputHashes: string[] = [];
	#toollessContinuationStreak = 0;
	#toollessStreakGoalId: string | null = null;
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
		this.#goal = null;
		this.#lastAgentEndMessages = [];
		this.#resetContinuationState();
		const events = this.#pi.events;
		if (events === undefined) return;
		this.#unsubscribeMonitorState = events.on(TERMINAL_MONITOR_STATE_EVENT, (data) => {
			if (!isTerminalMonitorStateEvent(data)) return;
			this.#activeMonitorCount = data.activeCount;
			if (data.activeCount === 0) {
				if (this.#scheduledContinuationKind === "monitor") this.#cancelTimer();
				this.#resetToollessContinuationStreak();
			}
		});
	}

	async afterAgentEnd(options: AgentEndOptions): Promise<Goal | null> {
		if (options.goal?.id !== this.#goal?.id) this.#resetToollessContinuationStreak();
		this.#ctx = options.ctx;
		this.#goal = options.goal;
		this.#lastAgentEndMessages = options.messages;
		this.#resetLengthRecoveryAfterCleanStop(options.goal, options.messages);
		this.#recordAssistantOutput(options.messages);
		if (options.goal?.status !== "active") {
			this.#cancelTimer();
			return options.goal;
		}
		this.#recordToollessContinuationTurn(options.goal, options.messages);

		const immediateInput = this.#buildVerdictInput(options.ctx, options.goal, "immediate", options.messages);
		const immediateVerdict = evaluateGoalContinuation({ goal: options.goal, ...immediateInput });
		if (immediateVerdict.kind === "deny") {
			if (immediateVerdict.reason === "not-eligible") return options.goal;
			if (immediateVerdict.reason === "grace") {
				this.#schedule(options.goal, "userGrace");
				return options.goal;
			}
		}

		if (this.#activeMonitorCount === 0) {
			this.#cancelTimer();
			return this.#admitAndQueue(options.ctx, options.goal, "immediate", options.messages);
		}
		this.#schedule(options.goal, "monitor");
		return options.goal;
	}

	syncGoal(goal: Goal | null): void {
		if (goal?.id !== this.#goal?.id) this.#resetContinuationState();
		this.#goal = goal;
		if (goal?.status !== "active") {
			this.#cancelTimer();
			this.#resetContinuationState();
		}
	}

	/** A real user prompt breaks unattended continuation state before its agent turn begins. */
	noteUserPrompt(): void {
		this.#cancelTimer();
		this.#endedTurnWasUserInitiated = true;
		this.#resetContinuationState();
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
	}

	#schedule(goal: Goal, kind: DelayedContinuationKind): void {
		if (this.#timer !== undefined) return;
		const delayMs = kind === "monitor" ? GOAL_MONITOR_CONTINUATION_DELAY_MS : GOAL_USER_GRACE_DELAY_MS;
		if (kind === "monitor") {
			if (this.#ctx?.hasUI) this.#ctx.ui.notify(GOAL_MONITOR_CONTINUATION_NOTICE, "info");
			this.#pi.events?.emit(GOAL_CONTINUATION_SCHEDULED_EVENT, {
				goalId: goal.id,
				delayMs,
				activeMonitorCount: this.#activeMonitorCount,
			});
		}
		this.#scheduledContinuationKind = kind;
		this.#timer = setTimeout(() => {
			void this.#continueIfEligible(kind).catch((error: unknown) => {
				if (this.#ctx?.hasUI) {
					const message = error instanceof Error ? error.message : String(error);
					this.#ctx.ui.notify(`Goal continuation delivery failed: ${message}`, "error");
				}
			});
		}, delayMs);
	}

	async #continueIfEligible(kind: DelayedContinuationKind): Promise<void> {
		this.#timer = undefined;
		this.#scheduledContinuationKind = undefined;
		const ctx = this.#ctx;
		const goal = this.#goal;
		if (ctx === undefined || goal?.status !== "active" || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		if (kind === "monitor" && this.#activeMonitorCount === 0) return;
		await this.#admitAndQueue(ctx, goal, kind === "monitor" ? "monitorDelayed" : "userGrace", this.#lastAgentEndMessages);
	}

	async #admitAndQueue(
		ctx: ExtensionContext,
		goal: Goal,
		path: GoalContinuationPath,
		messages: readonly AgentMessage[],
	): Promise<Goal> {
		const input = this.#buildVerdictInput(ctx, goal, path, messages);
		const verdict = evaluateGoalContinuation({ goal, ...input });
		const admittedGoal = await admitAndQueueGoalContinuation(this.#pi, ctx, goal, {
			input,
			content: (continuationVerdict) => this.#buildContinuationContent(ctx, goal, continuationVerdict),
			markContinuationPending: this.#markContinuationPending,
		});
		if (verdict.kind === "continue" && input.lastStopReason === "length") {
			this.#consecutiveLengthRecoveries.set(goal.id, input.consecutiveLengthRecoveries + 1);
		}
		this.#goal = admittedGoal;
		if (admittedGoal.status !== "active") {
			this.#cancelTimer();
			this.#resetToollessContinuationStreak();
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
			consecutiveLengthRecoveries: this.#consecutiveLengthRecoveries.get(goal.id) ?? 0,
			recentNormalizedOutputHashes: this.#recentNormalizedOutputHashes,
			toollessContinuationStreak: this.#toollessContinuationStreak,
			endedTurnWasUserInitiated: this.#endedTurnWasUserInitiated,
			continuationPending: this.#isContinuationPending(),
		};
	}

	#buildContinuationContent(ctx: ExtensionContext, goal: Goal, verdict: ContinuingGoalContinuationVerdict): string {
		let content = verdict.prompt === "minimal" ? buildTruncationRecoveryPrompt() : buildContinuationPrompt(goal);
		if (!verdict.stallNotice) return content;

		const monitorsActive = this.#activeMonitorCount > 0;
		this.#pi.events?.emit(GOAL_MONITOR_STALL_EVENT, {
			goalId: goal.id,
			consecutiveContinuations: this.#toollessContinuationStreak,
			toolless: true,
		});
		if (ctx.hasUI) {
			const context = monitorsActive ? "while monitors stayed active" : "without tool use";
			ctx.ui.notify(
				`Goal continuation repeated ${this.#toollessContinuationStreak} toolless turns ${context} - injected a stall check.`,
				"info",
			);
		}
		content = `${buildGoalStallNotice(this.#toollessContinuationStreak, { monitorsActive })}\n\n${content}`;
		return content;
	}

	#recordAssistantOutput(messages: readonly AgentMessage[]): void {
		const text = lastAssistantText(messages);
		if (normalizeAssistantText(text).length === 0) return;
		this.#recentNormalizedOutputHashes = [...this.#recentNormalizedOutputHashes, hashAssistantText(text)].slice(-3);
	}

	#recordToollessContinuationTurn(goal: Goal, messages: readonly AgentMessage[]): void {
		if (goal.id !== this.#toollessStreakGoalId) {
			this.#toollessStreakGoalId = goal.id;
			this.#toollessContinuationStreak = 0;
		}
		if (this.#endedTurnWasUserInitiated) return;
		if (continuationTurnUsedTools(messages)) {
			this.#toollessContinuationStreak = 0;
			return;
		}
		this.#toollessContinuationStreak += 1;
	}

	#resetLengthRecoveryAfterCleanStop(goal: Goal | null, messages: readonly AgentMessage[]): void {
		if (goal === null || findLastAssistantMessage(messages)?.stopReason !== "stop") return;
		this.#consecutiveLengthRecoveries.delete(goal.id);
	}

	#resetContinuationState(): void {
		this.#consecutiveLengthRecoveries.clear();
		this.#recentNormalizedOutputHashes = [];
		this.#resetToollessContinuationStreak();
	}

	#resetToollessContinuationStreak(): void {
		this.#toollessContinuationStreak = 0;
		this.#toollessStreakGoalId = null;
	}

	#cancelTimer(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#scheduledContinuationKind = undefined;
	}
}

function continuationTurnUsedTools(messages: readonly AgentMessage[]): boolean {
	return messages.some((message) => {
		if (message?.role === "toolResult") return true;
		return message?.role === "assistant" && message.content.some((content) => content.type === "toolCall");
	});
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
