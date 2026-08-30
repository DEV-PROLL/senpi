import { describe, expect, it, vi } from "vitest";

interface RejectionRecord {
	handled: boolean;
}

const pty = vi.hoisted(() => {
	const records: RejectionRecord[] = [];

	// A thenable standing in for a rejected feed/resize promise. It records
	// whether the caller ever attaches a rejection handler; with none, the
	// real promise would become an unhandled rejection and kill the host
	// process (the omo-ai Windows crash behind #837 / #1214).
	const observedRejection = (record: RejectionRecord): Promise<void> => {
		const failure = new Error("write data discarded, use flow control to avoid losing data");
		const thenable = {
			// biome-ignore lint/suspicious/noThenProperty: intentionally thenable so the test observes whether the call site attaches a rejection handler
			then(
				_onFulfilled?: ((value: undefined) => unknown) | null,
				onRejected?: ((reason: unknown) => unknown) | null,
			): Promise<void> {
				if (typeof onRejected === "function") {
					record.handled = true;
					onRejected(failure);
				}
				return Promise.resolve();
			},
			catch(onRejected?: ((reason: unknown) => unknown) | null): Promise<void> {
				return thenable.then(undefined, onRejected);
			},
			finally(onFinally?: (() => void) | null): Promise<void> {
				onFinally?.();
				return Promise.resolve();
			},
		};
		return thenable as unknown as Promise<void>;
	};

	class TerminalSession {
		backend: string | null = null;
		exited = false;
		exitResult = null;
		private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();

		constructor() {
			pty.sessions.push(this);
		}

		onData(listener: (chunk: Uint8Array) => void): () => void {
			this.dataListeners.add(listener);
			return () => this.dataListeners.delete(listener);
		}

		onExit(): () => void {
			return () => {};
		}

		start(): this {
			return this;
		}

		kill(): void {}

		emit(text: string): void {
			const chunk = new TextEncoder().encode(text);
			for (const listener of this.dataListeners) listener(chunk);
		}
	}

	class TerminalScreen {
		feed(): Promise<void> {
			const record: RejectionRecord = { handled: false };
			records.push(record);
			return observedRejection(record);
		}

		resize(): Promise<void> {
			const record: RejectionRecord = { handled: false };
			records.push(record);
			return observedRejection(record);
		}

		dispose(): void {}
	}

	return { TerminalScreen, TerminalSession, records, sessions: [] as TerminalSession[] };
});

vi.mock("@earendil-works/pi-pty", () => pty);

import { TerminalRuntimeSession } from "../src/core/extensions/builtin/terminal/runtime-session.ts";

describe("PTY runtime screen error ownership", () => {
	it("owns screen feed/resize rejections instead of leaking them unhandled", () => {
		const runtime = new TerminalRuntimeSession("screen-error-fixture", {});
		const session = pty.sessions.at(-1);
		if (!session) throw new Error("Terminal session was not created");

		session.emit("flood");
		runtime.resizeScreen(120, 40);

		expect(pty.records).toHaveLength(2);
		expect(pty.records.every((record) => record.handled)).toBe(true);
		expect(runtime.fullOutput()).toBe("flood");
		runtime.dispose();
	});
});
