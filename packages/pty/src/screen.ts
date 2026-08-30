import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import { MAX_PENDING_WRITE_CHARS, type ScreenOperation, settleOperation, trackSettler } from "./screen-operations.ts";
import {
	decodeInput,
	normalizeDimension,
	normalizeReplayHistoryLength,
	normalizeScrollback,
	readLine,
	sanitizeString,
} from "./screen-text.ts";

export interface TerminalScreenOptions {
	readonly cols?: number;
	readonly rows?: number;
	readonly scrollback?: number;
}

export interface TerminalScreenSnapshot {
	readonly cols: number;
	readonly rows: number;
	readonly visibleGrid: readonly string[];
	readonly scrollback: readonly string[];
	readonly cursor: {
		readonly x: number;
		readonly y: number;
	};
}

const XtermTerminal = xterm.Terminal;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Headless xterm screen model with serialized, flow-controlled writes.
 *
 * Every terminal mutation (feed, resize, backlog replay) runs through one
 * FIFO queue that awaits xterm's parse callback before issuing the next
 * write, so xterm's pending-write watermark can never be exceeded. When the
 * queued backlog outgrows {@link MAX_PENDING_WRITE_CHARS}, the queued writes
 * collapse into a single bounded history replay that reconstructs the same
 * screen state. After {@link TerminalScreen.dispose}, queued and future
 * operations settle as resolved no-ops; a terminal is never created after
 * disposal.
 */
export class TerminalScreen {
	private terminal: XtermTerminalType;
	private readonly history: string[] = [];
	private historyLength = 0;
	private readonly operations: ScreenOperation[] = [];
	private pendingWriteChars = 0;
	private draining = false;
	private disposed = false;
	private notifyDisposed: () => void = () => undefined;
	private readonly whenDisposed: Promise<void>;
	private readonly maxReplayHistoryLength: number;
	private readonly scrollback: number;

	constructor(options: TerminalScreenOptions = {}) {
		const cols = normalizeDimension(options.cols, DEFAULT_COLS);
		const rows = normalizeDimension(options.rows, DEFAULT_ROWS);
		this.scrollback = normalizeScrollback(options.scrollback);
		this.maxReplayHistoryLength = normalizeReplayHistoryLength(cols, rows, this.scrollback);
		this.whenDisposed = new Promise((resolve) => {
			this.notifyDisposed = resolve;
		});
		this.terminal = this.createTerminal(cols, rows);
	}

	feed(data: string | Uint8Array): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const payload = decodeInput(data);
		const sanitizedPayload = sanitizeString(payload);
		if (sanitizedPayload.length > 0) this.appendHistory(sanitizedPayload);
		if (this.pendingWriteChars + payload.length > MAX_PENDING_WRITE_CHARS) {
			return this.coalesceBacklogIntoReplay();
		}
		this.pendingWriteChars += payload.length;
		return this.enqueue({ kind: "write", payload, settlers: [] });
	}

	resize(cols: number, rows: number): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const nextCols = normalizeDimension(cols, this.terminal.cols);
		const nextRows = normalizeDimension(rows, this.terminal.rows);
		const tail = this.operations[this.operations.length - 1];
		if (tail !== undefined && tail.kind === "resize") {
			tail.cols = nextCols;
			tail.rows = nextRows;
			return trackSettler(tail.settlers);
		}
		return this.enqueue({ kind: "resize", cols: nextCols, rows: nextRows, settlers: [] });
	}

	flush(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		return this.enqueue({ kind: "write", payload: "", settlers: [] });
	}

	snapshot(): TerminalScreenSnapshot {
		const buffer = this.terminal.buffer.active;
		const viewportStart = buffer.viewportY;
		const visibleGrid: string[] = [];
		const scrollback: string[] = [];
		const scrollbackStart = Math.max(0, viewportStart - this.scrollback);

		for (let lineIndex = scrollbackStart; lineIndex < viewportStart; lineIndex += 1) {
			scrollback.push(readLine(buffer, lineIndex));
		}
		for (let row = 0; row < this.terminal.rows; row += 1) {
			visibleGrid.push(readLine(buffer, viewportStart + row));
		}

		return {
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			visibleGrid,
			scrollback,
			cursor: {
				x: buffer.cursorX,
				y: buffer.cursorY,
			},
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.notifyDisposed();
		const pending = this.operations.splice(0, this.operations.length);
		this.pendingWriteChars = 0;
		for (const operation of pending) {
			settleOperation(operation.settlers, null);
		}
		this.terminal.dispose();
	}

	private createTerminal(cols: number, rows: number): XtermTerminalType {
		return new XtermTerminal({
			cols,
			rows,
			scrollback: this.scrollback,
			disableStdin: true,
			allowProposedApi: true,
			logLevel: "off",
		});
	}

	private enqueue(operation: ScreenOperation): Promise<void> {
		this.operations.push(operation);
		const settled = trackSettler(operation.settlers);
		void this.drain();
		return settled;
	}

	/**
	 * Route an over-cap feed to the queue's replay operation instead of
	 * enqueueing another write. The feed's payload already lives in `history`,
	 * and a replay renders `history` at run time, so settling with the replay's
	 * outcome loses nothing. Settlers attach one at a time; no unbounded spread
	 * or snapshot string is ever built here.
	 */
	private coalesceBacklogIntoReplay(): Promise<void> {
		const tail = this.operations[this.operations.length - 1];
		if (tail !== undefined && tail.kind === "replay") {
			return trackSettler(tail.settlers);
		}
		return this.enqueue({ kind: "replay", settlers: [] });
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (!this.disposed) {
				const operation = this.operations.shift();
				if (operation === undefined) return;
				if (operation.kind === "write") this.pendingWriteChars -= operation.payload.length;
				try {
					await this.run(operation);
					settleOperation(operation.settlers, null);
				} catch (error) {
					settleOperation(operation.settlers, error instanceof Error ? error : new Error(String(error)));
				}
			}
		} finally {
			this.draining = false;
		}
	}

	private async run(operation: ScreenOperation): Promise<void> {
		if (this.disposed) return;
		switch (operation.kind) {
			case "write":
				await this.raceDisposal(this.write(operation.payload));
				return;
			case "replay":
				this.absorbQueuedWrites(operation);
				this.terminal.reset();
				await this.raceDisposal(this.write(this.history.join("")));
				return;
			case "resize":
				this.absorbQueuedWrites(operation);
				this.terminal.dispose();
				this.terminal = this.createTerminal(operation.cols, operation.rows);
				await this.raceDisposal(this.write(this.history.join("")));
				return;
		}
	}

	/**
	 * A replay or resize renders the full bounded `history` at run time, which
	 * already contains every queued write's payload; running those writes
	 * afterwards would duplicate their content on the fresh screen. Absorb
	 * them instead: remove the queued writes and settle them with this
	 * operation's outcome.
	 */
	private absorbQueuedWrites(into: ScreenOperation): void {
		for (let index = this.operations.length - 1; index >= 0; index -= 1) {
			const operation = this.operations[index];
			if (operation === undefined || operation.kind !== "write") continue;
			this.pendingWriteChars -= operation.payload.length;
			for (const settler of operation.settlers) into.settlers.push(settler);
			operation.settlers.length = 0;
			this.operations.splice(index, 1);
		}
	}

	/** A disposed terminal may never invoke its parse callback; do not hang. */
	private raceDisposal(written: Promise<void>): Promise<void> {
		return Promise.race([written, this.whenDisposed]);
	}

	private write(payload: string): Promise<void> {
		return new Promise((resolve, reject) => {
			try {
				this.terminal.write(payload, resolve);
			} catch (error) {
				const sanitizedPayload = sanitizeString(payload);
				if (sanitizedPayload === payload) {
					reject(error instanceof Error ? error : new Error(String(error)));
					return;
				}
				this.terminal.write(sanitizedPayload, resolve);
			}
		});
	}

	private appendHistory(payload: string): void {
		this.history.push(payload);
		this.historyLength += payload.length;
		this.trimHistory();
	}

	private trimHistory(): void {
		while (this.historyLength > this.maxReplayHistoryLength && this.history.length > 1) {
			const removed = this.history.shift();
			if (removed === undefined) return;
			this.historyLength -= removed.length;
		}

		if (this.historyLength <= this.maxReplayHistoryLength) return;
		const [onlyChunk] = this.history;
		if (onlyChunk === undefined) return;
		const trimmed = sanitizeString(onlyChunk.slice(-this.maxReplayHistoryLength));
		this.history[0] = trimmed;
		this.historyLength = trimmed.length;
	}
}
