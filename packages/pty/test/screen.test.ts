import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { TerminalScreen } from "../src/screen.ts";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("TerminalScreen", () => {
	it("captures ANSI visible lines as plain visible grid text", async () => {
		const screen = new TerminalScreen({ cols: 10, rows: 3, scrollback: 10 });
		await screen.feed(bytes("\x1b[31mred\x1b[0m\r\nplain"));

		const snapshot = screen.snapshot();

		expect(snapshot.visibleGrid).toEqual(["red", "plain", ""]);
		expect(snapshot.cursor).toEqual({ x: 5, y: 1 });
	});

	it("tracks cursor moves and clear-line sequences", async () => {
		const screen = new TerminalScreen({ cols: 12, rows: 4, scrollback: 10 });
		await screen.feed(bytes("alpha\r\nbeta\r\ncharlie"));
		await screen.feed(bytes("\x1b[2;1H\x1b[2Kdone"));

		const snapshot = screen.snapshot();

		expect(snapshot.visibleGrid).toEqual(["alpha", "done", "charlie", ""]);
		expect(snapshot.cursor).toEqual({ x: 4, y: 1 });
	});

	it("reflows wrapped lines when resized", async () => {
		const screen = new TerminalScreen({ cols: 6, rows: 4, scrollback: 10 });
		await screen.feed(bytes("abcdefghi"));
		await screen.resize(3, 4);

		const snapshot = screen.snapshot();

		expect(snapshot.cols).toBe(3);
		expect(snapshot.visibleGrid).toEqual(["abc", "def", "ghi", ""]);
	});

	it("caps scrollback in snapshots", async () => {
		const screen = new TerminalScreen({ cols: 8, rows: 2, scrollback: 3 });
		await screen.feed(bytes("l1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6"));

		const snapshot = screen.snapshot();

		expect(snapshot.scrollback).toEqual(["l2", "l3", "l4"]);
		expect(snapshot.visibleGrid).toEqual(["l5", "l6"]);
	});

	it("sanitizes malformed UTF-8 bytes without throwing", async () => {
		const screen = new TerminalScreen({ cols: 20, rows: 2, scrollback: 10 });
		await screen.feed(new Uint8Array([0x6f, 0x6b, 0x20, 0xe2, 0x28, 0xa1]));

		const snapshot = screen.snapshot();

		expect(snapshot.visibleGrid[0]).toBe("ok \uFFFD(\uFFFD");
		expect(snapshot.visibleGrid[0]).not.toContain("\u0000");
	});

	it("falls back to a sanitized write when xterm rejects malformed text", async () => {
		const originalWrite = xterm.Terminal.prototype.write;
		const writes: string[] = [];
		let rejectedRawPayload = false;

		xterm.Terminal.prototype.write = function patchedWrite(
			this: XtermTerminalType,
			data: string | Uint8Array,
			callback?: () => void,
		): void {
			const payload = typeof data === "string" ? data : new TextDecoder().decode(data);
			writes.push(payload);
			if (!rejectedRawPayload && payload.includes("\ud800")) {
				rejectedRawPayload = true;
				throw new Error("mock xterm malformed text rejection");
			}
			originalWrite.call(this, data, callback);
		};

		try {
			const screen = new TerminalScreen({ cols: 20, rows: 2, scrollback: 10 });
			await screen.feed("ok \ud800");

			const snapshot = screen.snapshot();

			expect(rejectedRawPayload).toBe(true);
			expect(writes).toContain("ok \ud800");
			expect(writes).toContain("ok \uFFFD");
			expect(snapshot.visibleGrid[0]).toBe("ok \uFFFD");
		} finally {
			xterm.Terminal.prototype.write = originalWrite;
		}
	});

	it("serializes concurrent feeds through xterm write callbacks", async () => {
		const originalWrite = xterm.Terminal.prototype.write;
		let writePending = false;

		xterm.Terminal.prototype.write = function patchedWrite(
			this: XtermTerminalType,
			data: string | Uint8Array,
			callback?: () => void,
		): void {
			if (writePending) {
				throw new Error("write data discarded, use flow control to avoid losing data");
			}
			writePending = true;
			originalWrite.call(this, data, () => {
				writePending = false;
				callback?.();
			});
		};

		try {
			const screen = new TerminalScreen({ cols: 20, rows: 2, scrollback: 10 });
			await Promise.all([screen.feed("first"), screen.feed(" second"), screen.feed(" third")]);

			expect(screen.snapshot().visibleGrid[0]).toBe("first second third");
		} finally {
			xterm.Terminal.prototype.write = originalWrite;
		}
	});

	it("orders resize replay between concurrent feeds", async () => {
		const screen = new TerminalScreen({ cols: 6, rows: 4, scrollback: 10 });

		await Promise.all([screen.feed("abcdef"), screen.resize(3, 4), screen.feed("ghi")]);

		const snapshot = screen.snapshot();
		expect(snapshot.cols).toBe(3);
		expect(snapshot.visibleGrid).toEqual(["abc", "def", "ghi", ""]);
	});

	it("bounds resize replay history in long sessions", async () => {
		const originalWrite = xterm.Terminal.prototype.write;
		const replayLengths: number[] = [];
		let capturingResizeReplay = false;

		xterm.Terminal.prototype.write = function patchedWrite(
			this: XtermTerminalType,
			data: string | Uint8Array,
			callback?: () => void,
		): void {
			if (capturingResizeReplay) {
				replayLengths.push(typeof data === "string" ? data.length : data.byteLength);
			}
			originalWrite.call(this, data, callback);
		};

		try {
			const screen = new TerminalScreen({ cols: 12, rows: 2, scrollback: 2 });
			for (let index = 0; index < 1200; index += 1) {
				await screen.feed(bytes(`line-${String(index).padStart(4, "0")}\r\n`));
			}

			capturingResizeReplay = true;
			await screen.resize(12, 2);

			const snapshot = screen.snapshot();

			expect(Math.max(...replayLengths)).toBeLessThanOrEqual(4096);
			expect(snapshot.visibleGrid).toEqual(["line-1199", ""]);
			expect(snapshot.scrollback).toEqual(["line-1197", "line-1198"]);
		} finally {
			xterm.Terminal.prototype.write = originalWrite;
		}
		// 1200 awaited xterm feeds are well under the 5s default on POSIX runners
		// but exceed it on the slower Windows CI runner; give this long-session
		// case explicit headroom rather than weakening the scrollback coverage.
	}, 30000);

	it("survives an unawaited feed flood beyond xterm's pending-write watermark", async () => {
		const screen = new TerminalScreen({ cols: 80, rows: 24, scrollback: 100 });
		const chunk = `${"x".repeat(4095)}\n`;

		const results = await Promise.allSettled(Array.from({ length: 13_000 }, () => screen.feed(chunk)));

		const rejected = results.filter((result) => result.status === "rejected");
		expect(rejected).toEqual([]);

		await screen.flush();
		expect(screen.snapshot().visibleGrid.some((line) => line.includes("x"))).toBe(true);
		screen.dispose();
	}, 60_000);

	it("settles queued operations on dispose without recreating a terminal", async () => {
		const originalWrite = xterm.Terminal.prototype.write;
		const originalDispose = xterm.Terminal.prototype.dispose;
		let disposeCalls = 0;
		let writesAfterDispose = 0;
		let screenDisposed = false;

		xterm.Terminal.prototype.write = function patchedWrite(
			this: XtermTerminalType,
			data: string | Uint8Array,
			callback?: () => void,
		): void {
			if (screenDisposed) writesAfterDispose += 1;
			originalWrite.call(this, data, callback);
		};
		xterm.Terminal.prototype.dispose = function patchedDispose(this: XtermTerminalType): void {
			disposeCalls += 1;
			originalDispose.call(this);
		};

		try {
			const screen = new TerminalScreen({ cols: 20, rows: 4, scrollback: 10 });
			const outcomes = [screen.feed("before"), screen.resize(40, 5), screen.feed(" after")];
			screenDisposed = true;
			screen.dispose();

			await expect(Promise.all(outcomes)).resolves.toEqual([undefined, undefined, undefined]);
			expect(writesAfterDispose).toBe(0);
			expect(disposeCalls).toBe(1);
		} finally {
			xterm.Terminal.prototype.write = originalWrite;
			xterm.Terminal.prototype.dispose = originalDispose;
		}
	});

	it("bounds the queued write backlog by coalescing into a bounded replay", async () => {
		const originalWrite = xterm.Terminal.prototype.write;
		let writtenChars = 0;

		xterm.Terminal.prototype.write = function patchedWrite(
			this: XtermTerminalType,
			data: string | Uint8Array,
			callback?: () => void,
		): void {
			writtenChars += typeof data === "string" ? data.length : data.byteLength;
			originalWrite.call(this, data, callback);
		};

		try {
			const screen = new TerminalScreen({ cols: 20, rows: 4, scrollback: 10 });
			const chunk = "y".repeat(65_536);
			const results = await Promise.allSettled(Array.from({ length: 96 }, () => screen.feed(chunk)));

			expect(results.every((result) => result.status === "fulfilled")).toBe(true);
			// 6 MiB submitted; the parsed volume must stay near the 1 MiB pending
			// cap plus the bounded replay, nowhere near the full submission.
			expect(writtenChars).toBeLessThan(3 * 1_048_576);
			screen.dispose();
		} finally {
			xterm.Terminal.prototype.write = originalWrite;
		}
	}, 30_000);

	it("delivers write rejections to the owning caller and keeps the queue usable", async () => {
		const originalWrite = xterm.Terminal.prototype.write;

		xterm.Terminal.prototype.write = function patchedWrite(
			this: XtermTerminalType,
			data: string | Uint8Array,
			callback?: () => void,
		): void {
			const payload = typeof data === "string" ? data : new TextDecoder().decode(data);
			if (payload.includes("poison")) throw new Error("synthetic xterm write failure");
			originalWrite.call(this, data, callback);
		};

		try {
			const screen = new TerminalScreen({ cols: 20, rows: 2, scrollback: 10 });
			await screen.feed("ok");
			await expect(screen.feed("poison")).rejects.toThrow("synthetic xterm write failure");
			await expect(screen.feed(" fine")).resolves.toBeUndefined();
			expect(screen.snapshot().visibleGrid[0]).toBe("ok fine");
			screen.dispose();
		} finally {
			xterm.Terminal.prototype.write = originalWrite;
		}
	});
});
