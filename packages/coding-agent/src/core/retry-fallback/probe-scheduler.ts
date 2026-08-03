/**
 * Bounded probe-back scheduler for tier-2 demoted selectors.
 *
 * Owns ONE armed probe plan per session: at most two probes (first at half-hint,
 * then at the absolute deadline), never two in-flight simultaneously. Arming
 * while armed silently supersedes the previous plan. cancel() aborts any
 * in-flight probe and clears pending timers — no further emits after cancel.
 *
 * All timers go through the injected `setTimeout`/`clearTimeout` pair so tests
 * can drive them deterministically with fake timers.
 */

export interface ProbeBackArmInput {
	selector: string;
	firstAtMs: number;
	deadlineMs: number;
	authAvailable: () => boolean;
	runProbe: (signal: AbortSignal) => Promise<boolean>;
	onCleared: (selector: string) => void;
	emit: (event: ProbeBackEvent) => void;
}

export type ProbeBackEvent =
	| { type: "retry_probe_scheduled"; selector: string; atMs: number; probeIndex: 1 | 2 }
	| { type: "retry_probe_result"; selector: string; ok: boolean; errorMessage?: string };

export type ProbeBackCancelReason = "manual-model-change" | "dispose" | "superseded";

interface ScheduledTimer {
	handle: unknown;
}

export class ProbeBackScheduler {
	private readonly _now: () => number;
	private readonly _setTimeout: (callback: () => void, delay: number) => unknown;
	private readonly _clearTimeout: (handle: unknown) => void;

	private _armed = false;
	private _firstTimer: ScheduledTimer | undefined;
	private _deadlineTimer: ScheduledTimer | undefined;
	private _abortController: AbortController | undefined;

	constructor(opts: {
		now: () => number;
		setTimeout?: (callback: () => void, delay: number) => unknown;
		clearTimeout?: (handle: unknown) => void;
	}) {
		this._now = opts.now;
		this._setTimeout = opts.setTimeout ?? ((cb, d) => setTimeout(cb, d));
		this._clearTimeout = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	get active(): boolean {
		return this._armed;
	}

	arm(input: ProbeBackArmInput): void {
		// Supersede any existing plan silently.
		if (this._armed) {
			this._clearTimers();
			this._abortInFlight("superseded");
		}

		this._armed = true;
		this._firstTimer = { handle: undefined };
		this._deadlineTimer = { handle: undefined };

		// Emit scheduled event for probe 1.
		input.emit({
			type: "retry_probe_scheduled",
			selector: input.selector,
			atMs: input.firstAtMs,
			probeIndex: 1,
		});

		const delay = Math.max(0, input.firstAtMs - this._now());
		this._firstTimer.handle = this._setTimeout(() => {
			void this._runProbe(input, 1);
		}, delay);
	}

	cancel(reason: ProbeBackCancelReason): void {
		if (!this._armed) return;
		this._clearTimers();
		this._abortInFlight(reason);
		this._disarm();
	}

	private _clearTimers(): void {
		if (this._firstTimer?.handle !== undefined) {
			this._clearTimeout(this._firstTimer.handle);
			this._firstTimer.handle = undefined;
		}
		if (this._deadlineTimer?.handle !== undefined) {
			this._clearTimeout(this._deadlineTimer.handle);
			this._deadlineTimer.handle = undefined;
		}
	}

	private _abortInFlight(_reason: ProbeBackCancelReason): void {
		if (this._abortController) {
			this._abortController.abort();
			this._abortController = undefined;
		}
	}

	private _disarm(): void {
		this._armed = false;
		this._firstTimer = undefined;
		this._deadlineTimer = undefined;
		this._abortController = undefined;
	}

	private async _runProbe(input: ProbeBackArmInput, probeIndex: 1 | 2): Promise<void> {
		// Clear the timer that just fired so cancel doesn't try to clear a stale handle.
		if (probeIndex === 1 && this._firstTimer) {
			this._firstTimer.handle = undefined;
		} else if (this._deadlineTimer) {
			this._deadlineTimer.handle = undefined;
		}

		// Guard: auth unavailable -> fail immediately, disarm.
		if (!input.authAvailable()) {
			input.emit({
				type: "retry_probe_result",
				selector: input.selector,
				ok: false,
				errorMessage: "auth-unavailable",
			});
			this._disarm();
			return;
		}

		// Set up abort controller for the in-flight probe.
		this._abortController = new AbortController();

		let success: boolean;
		try {
			success = await input.runProbe(this._abortController.signal);
		} catch {
			success = false;
		}

		// If cancelled during the probe, abortController is already cleaned by cancel.
		// Check if we're still armed (cancel may have fired mid-flight).
		if (!this._armed) return;

		this._abortController = undefined;

		if (success) {
			input.onCleared(input.selector);
			input.emit({
				type: "retry_probe_result",
				selector: input.selector,
				ok: true,
			});
			this._disarm();
			return;
		}

		// First probe failed — schedule the deadline probe if we haven't used both slots.
		if (probeIndex === 1) {
			// Emit scheduled event for probe 2.
			input.emit({
				type: "retry_probe_scheduled",
				selector: input.selector,
				atMs: input.deadlineMs,
				probeIndex: 2,
			});

			const delay = Math.max(0, input.deadlineMs - this._now());
			if (this._deadlineTimer) {
				this._deadlineTimer.handle = this._setTimeout(() => {
					void this._runProbe(input, 2);
				}, delay);
			}
			return;
		}

		// Second probe failed — final result, disarm.
		input.emit({
			type: "retry_probe_result",
			selector: input.selector,
			ok: false,
		});
		this._disarm();
	}
}
