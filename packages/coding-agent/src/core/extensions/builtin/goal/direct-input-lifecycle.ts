import type { ExtensionContext, InputDispositionEvent, InputEvent } from "../../types.ts";
import { isMechanicalContinuationBlock } from "./continuation-recovery.ts";
import { buildCurrentGoalContinuationSignatureFromBranch } from "./lifecycle-helpers.ts";
import type { MonitorAwareGoalContinuation } from "./monitor-continuation.ts";
import { readGoal, resetContinuationStreak, updateGoal } from "./store.ts";
import type { Goal, GoalStoreRef } from "./types.ts";

type DirectInputAction = "pause" | "reactivate";

type DirectInputCandidate = {
	readonly goalId: string | null;
	readonly action?: DirectInputAction;
};

type DirectInputLifecycleDependencies = {
	readonly monitor: MonitorAwareGoalContinuation;
	readonly goalStoreRef: (ctx: ExtensionContext) => GoalStoreRef;
	readonly isAgentTurnInProgress: () => boolean;
	readonly accountCurrentAgentTurn: (ctx: ExtensionContext) => Promise<Goal | null>;
	readonly clearAgentGoalAccounting: () => void;
	readonly beginAgentGoalAccounting: (goal: Goal) => void;
	readonly refreshGoalUi: (ctx: ExtensionContext, goal: Goal) => void;
};

/** Correlates raw input with admission before changing persisted Goal state. */
export class GoalDirectInputLifecycle {
	readonly #dependencies: DirectInputLifecycleDependencies;
	readonly #candidates = new Map<string, DirectInputCandidate>();
	readonly #pendingPauseGoalIds = new Set<string>();

	constructor(dependencies: DirectInputLifecycleDependencies) {
		this.#dependencies = dependencies;
	}

	reset(): void {
		this.#candidates.clear();
		this.#pendingPauseGoalIds.clear();
	}

	async onInput(event: InputEvent, ctx: ExtensionContext): Promise<void> {
		if (event.source === "extension" || event.streamingBehavior === "steer") return;

		this.#dependencies.monitor.holdDirectInput(event.inputId);
		this.#candidates.set(event.inputId, { goalId: null });
		const goal = await readGoal(this.#dependencies.goalStoreRef(ctx));
		if (goal === null) return;

		let action: DirectInputAction | undefined;
		if (goal.status === "blocked" && isMechanicalContinuationBlock(goal.blockedReason)) {
			action = "reactivate";
		} else if (
			goal.status === "active" &&
			goal.lastContinuationSignature !== undefined &&
			goal.lastContinuationSignature === buildCurrentGoalContinuationSignatureFromBranch(ctx, goal)
		) {
			action = "pause";
		}
		this.#candidates.set(event.inputId, { goalId: goal.id, ...(action === undefined ? {} : { action }) });
	}

	async onDisposition(event: InputDispositionEvent, ctx: ExtensionContext): Promise<void> {
		const candidate = this.#candidates.get(event.inputId);
		if (candidate === undefined) return;
		this.#candidates.delete(event.inputId);
		const accepted = event.disposition === "started" || event.disposition === "queued";
		this.#dependencies.monitor.resolveDirectInput(event.inputId, accepted);
		if (!accepted || candidate.goalId === null) return;

		const ref = this.#dependencies.goalStoreRef(ctx);
		const currentGoal = await readGoal(ref);
		if (currentGoal?.id !== candidate.goalId) return;

		if (candidate.action === "reactivate") {
			if (currentGoal.status !== "blocked" || !isMechanicalContinuationBlock(currentGoal.blockedReason)) return;
			await resetContinuationStreak(ref);
			const reactivated = await updateGoal(ref, { status: "active" }, "user");
			this.#dependencies.beginAgentGoalAccounting(reactivated);
			this.#dependencies.refreshGoalUi(ctx, reactivated);
			return;
		}

		if (candidate.action === "pause") {
			if (currentGoal.status !== "active") return;
			if (this.#dependencies.isAgentTurnInProgress()) {
				this.#pendingPauseGoalIds.add(currentGoal.id);
				return;
			}
			await this.#dependencies.accountCurrentAgentTurn(ctx);
			const paused = await updateGoal(ref, { status: "paused" }, "user");
			this.#dependencies.clearAgentGoalAccounting();
			this.#dependencies.refreshGoalUi(ctx, paused);
			return;
		}

		if (currentGoal.status !== "active") return;
		const reset = await resetContinuationStreak(ref);
		if (reset !== null) this.#dependencies.refreshGoalUi(ctx, reset);
	}

	async applyPendingPauseAfterAgentEnd(ctx: ExtensionContext, goal: Goal | null): Promise<Goal | null> {
		const shouldPause = goal !== null && this.#pendingPauseGoalIds.has(goal.id);
		this.#pendingPauseGoalIds.clear();
		if (!shouldPause || goal?.status !== "active") return goal;
		return updateGoal(this.#dependencies.goalStoreRef(ctx), { status: "paused" }, "user");
	}
}
