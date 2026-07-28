import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalRuntimeSession } from "../../src/core/extensions/builtin/terminal/runtime-session.ts";
import { createForegroundDetachGate } from "../../src/core/extensions/builtin/terminal/tools/foreground-detach.ts";

/**
 * Deterministic stand-in for the pty session: `settle()` runs registered exit
 * handlers synchronously (mirroring `settleExit`, which sets `settledExit`
 * before dispatching), and `onExit` on an already-settled session defers to a
 * microtask exactly as `TerminalSession.onExit` does.
 */
function fakeRuntime() {
	const handlers = new Set<() => void>();
	let settled = false;
	return {
		get exited(): boolean {
			return settled;
		},
		session: {
			onExit(handler: () => void): () => void {
				if (settled) queueMicrotask(handler);
				else handlers.add(handler);
				return () => handlers.delete(handler);
			},
		},
		settle(): void {
			if (settled) return;
			settled = true;
			for (const handler of handlers) handler();
			handlers.clear();
		},
	};
}

type Fake = ReturnType<typeof fakeRuntime>;

function gateFor(runtime: Fake, signal?: AbortSignal) {
	let removeAbortCalls = 0;
	let detached = false;
	const gate = createForegroundDetachGate({
		runtime: runtime as unknown as TerminalRuntimeSession,
		signal,
		delayMs: 0,
		removeAbortListener: () => {
			removeAbortCalls += 1;
		},
	});
	void gate.detached.then(() => {
		detached = true;
	});
	return {
		gate,
		state: () => ({ detached, removeAbortCalls }),
	};
}

/**
 * Advance the fake clock so the deadline timer runs, WITHOUT yielding to the
 * microtask queue — this is the exact window in which the gate must still let
 * a late exit or abort win.
 */
function fireDeadlineOnly(): void {
	vi.advanceTimersByTime(1);
}

/** Yield so queued microtasks (and therefore any commit) become observable. */
async function settleScheduling(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("createForegroundDetachGate linearization", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not detach when the command exits inside the linearization window", async () => {
		const runtime = fakeRuntime();
		const { state } = gateFor(runtime);

		fireDeadlineOnly();
		runtime.settle();
		await settleScheduling();

		expect(state()).toEqual({ detached: false, removeAbortCalls: 0 });
	});

	it("does not detach when the command already exited before the deadline", async () => {
		const runtime = fakeRuntime();
		const { state } = gateFor(runtime);

		runtime.settle();
		fireDeadlineOnly();
		await settleScheduling();

		expect(state()).toEqual({ detached: false, removeAbortCalls: 0 });
	});

	it("does not detach when an abort lands inside the linearization window", async () => {
		const runtime = fakeRuntime();
		const controller = new AbortController();
		const { state } = gateFor(runtime, controller.signal);

		fireDeadlineOnly();
		controller.abort();
		await settleScheduling();

		expect(state()).toEqual({ detached: false, removeAbortCalls: 0 });
	});

	it("detaches exactly once and drops the abort listener when the command is still running", async () => {
		const runtime = fakeRuntime();
		const { state } = gateFor(runtime);

		fireDeadlineOnly();
		await settleScheduling();

		expect(state()).toEqual({ detached: true, removeAbortCalls: 1 });
	});

	it("keeps the exit result authoritative when onExit dispatches synchronously at registration", async () => {
		const runtime = fakeRuntime();
		const synchronousExit = {
			get exited(): boolean {
				return false;
			},
			session: {
				onExit(handler: () => void): () => void {
					handler();
					return () => {};
				},
			},
		};
		const { state } = gateFor(synchronousExit as unknown as Fake);

		fireDeadlineOnly();
		await settleScheduling();
		expect(runtime.exited).toBe(false);

		expect(state()).toEqual({ detached: false, removeAbortCalls: 0 });
	});

	it("suppresses a pending detach once cancelled", async () => {
		const runtime = fakeRuntime();
		const { gate, state } = gateFor(runtime);

		gate.cancel();
		fireDeadlineOnly();
		await settleScheduling();

		expect(state()).toEqual({ detached: false, removeAbortCalls: 0 });
	});
});
