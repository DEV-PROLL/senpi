import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import {
	MAX_PENDING_WRITE_CHARS,
	type ReplayOperation,
	type ResizeOperation,
	type ScreenOperation,
	settleOperation,
	sharedSettler,
	trackSettler,
} from "./screen-operations.ts";
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
	private historyHeadChunks = 0;
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
		const operation: ScreenOperation = { kind: "write", payload, settlers: [] };
		return this.enqueue(operation, trackSettler(operation.settlers));
	}

	resize(cols: number, rows: number): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const nextCols = normalizeDimension(cols, this.terminal.cols);
		const nextRows = normalizeDimension(rows, this.terminal.rows);
		const tail = this.operations[this.operations.length - 1];
		if (tail !== undefined && tail.kind === "resize") {
			tail.cols = nextCols;
			tail.rows = nextRows;
			tail.historyMark = this.historyEnd();
			return sharedSettler(tail);
		}
		const operation: ResizeOperation = {
			kind: "resize",
			cols: nextCols,
			rows: nextRows,
			historyMark: this.historyEnd(),
			settled: null,
			settlers: [],
		};
		return this.enqueue(operation, sharedSettler(operation));
	}

	flush(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const operation: ScreenOperation = { kind: "write", payload: "", settlers: [] };
		return this.enqueue(operation, trackSettler(operation.settlers));
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

	private enqueue(operation: ScreenOperation, settled: Promise<void>): Promise<void> {
		this.operations.push(operation);
		void this.drain();
		return settled;
	}

	/**
	 * Route an over-cap feed to the queue's tail replay instead of enqueueing
	 * another write. The feed's payload already lives in `history` and the
	 * replay renders history up to its mark, so advancing the mark and sharing
	 * the replay's promise loses nothing while keeping the queue, its settler
	 * memory, and the replay payload all O(1) per queued operation.
	 */
	private coalesceBacklogIntoReplay(): Promise<void> {
		const tail = this.operations[this.operations.length - 1];
		if (tail !== undefined && tail.kind === "replay") {
			tail.historyMark = this.historyEnd();
			return sharedSettler(tail);
		}
		const operation: ReplayOperation = {
			kind: "replay",
			historyMark: this.historyEnd(),
			settled: null,
			settlers: [],
		};
		return this.enqueue(operation, sharedSettler(operation));
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
				this.terminal.reset();
				await this.raceDisposal(this.write(this.renderHistory(operation.historyMark)));
				return;
			case "resize":
				this.terminal.dispose();
				this.terminal = this.createTerminal(operation.cols, operation.rows);
				await this.raceDisposal(this.write(this.renderHistory(operation.historyMark)));
				return;
		}
	}

	/**
	 * Render only the history recorded up to the operation's mark. Feeds made
	 * after the mark keep their own queued writes and land after this barrier,
	 * preserving FIFO order; feeds before it drained ahead of the barrier and
	 * are reproduced exactly by the replayed prefix.
	 */
	private renderHistory(historyMark: number): string {
		const end = Math.max(0, historyMark - this.historyHeadChunks);
		return this.history.slice(0, end).join("");
	}

	private historyEnd(): number {
		return this.historyHeadChunks + this.history.length;
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
			this.historyHeadChunks += 1;
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
