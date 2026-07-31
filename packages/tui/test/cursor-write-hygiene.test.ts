import assert from "node:assert";
import { describe, it } from "node:test";
import { Input } from "../src/components/input.ts";
import { setCapabilities } from "../src/terminal-image.ts";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const FRAME_BEGIN = "\x1b[?2026h";
const FRAME_END = "\x1b[?2026l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

interface OutputChunk {
	readonly kind: "write" | "hideCursor" | "showCursor";
	readonly data: string;
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private readonly chunks: OutputChunk[] = [];

	override write(data: string): void {
		this.chunks.push({ kind: "write", data });
		super.write(data);
	}

	override hideCursor(): void {
		this.chunks.push({ kind: "hideCursor", data: HIDE_CURSOR });
		super.hideCursor();
	}

	override showCursor(): void {
		this.chunks.push({ kind: "showCursor", data: SHOW_CURSOR });
		super.showCursor();
	}

	getChunks(): readonly OutputChunk[] {
		return this.chunks;
	}
}

class CursorComponent implements Component, Focusable {
	focused = false;
	private frame = 0;

	nextFrame(): void {
		this.frame += 1;
	}

	render(_width: number): string[] {
		const marker = this.focused ? CURSOR_MARKER : "";
		return [`frame ${this.frame} ${marker}`];
	}

	invalidate(): void {}
}

class StyledCursorComponent implements Component, Focusable {
	focused = false;

	render(_width: number): string[] {
		const marker = this.focused ? CURSOR_MARKER : "";
		return [`\x1b[1;31mA${marker}\x1b[7m한\x1b[27mB\x1b[0m`];
	}

	invalidate(): void {}
}

function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

async function renderNextFrame(tui: TUI, terminal: VirtualTerminal, component: CursorComponent): Promise<void> {
	component.nextFrame();
	tui.requestRender();
	await terminal.waitForRender();
}

function outputText(chunks: readonly OutputChunk[]): string {
	return chunks.map((chunk) => chunk.data).join("");
}

function assertAtomicFrameWrites(chunks: readonly OutputChunk[]): void {
	const result: OutputChunk[][] = [];
	let active: OutputChunk[] | undefined;

	for (const chunk of chunks) {
		if (chunk.data.includes(FRAME_BEGIN)) {
			assert.strictEqual(chunk.kind, "write");
			assert.ok(chunk.data.startsWith(FRAME_BEGIN));
			assert.strictEqual(countOccurrences(chunk.data, FRAME_BEGIN), countOccurrences(chunk.data, FRAME_END));
			assert.ok(chunk.data.endsWith(FRAME_END));
			active = undefined;
		}
		if (active) {
			result[result.length - 1]?.push(chunk);
		}
		if (chunk.data.includes(FRAME_END)) {
			active = [];
			result.push(active);
		}
	}

	for (const trailingChunks of result) {
		assert.strictEqual(trailingChunks.length, 0);
	}
}

async function startHiddenCursorTui(): Promise<{
	readonly terminal: LoggingVirtualTerminal;
	readonly tui: TUI;
	readonly component: CursorComponent;
}> {
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	const terminal = new LoggingVirtualTerminal(40, 6);
	const tui = new TUI(terminal, false);
	const component = new CursorComponent();
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	await terminal.waitForRender();
	return { terminal, tui, component };
}

describe("cursor write hygiene", () => {
	it("omits repeated hidden cursor bytes after the first hidden frame", async () => {
		const { terminal, tui, component } = await startHiddenCursorTui();

		// given
		await renderNextFrame(tui, terminal, component);
		const hideBytesAfterFrameOne = countOccurrences(outputText(terminal.getChunks()), HIDE_CURSOR);

		// when
		await renderNextFrame(tui, terminal, component);
		await renderNextFrame(tui, terminal, component);

		// then
		const hideBytesAfterSteadyFrames = countOccurrences(outputText(terminal.getChunks()), HIDE_CURSOR);
		assert.strictEqual(hideBytesAfterSteadyFrames, hideBytesAfterFrameOne);

		tui.stop();
	});

	it("keeps cursor restoration inside each synchronized frame", async () => {
		const { terminal, tui, component } = await startHiddenCursorTui();

		// given
		await renderNextFrame(tui, terminal, component);

		// when
		await renderNextFrame(tui, terminal, component);

		// then
		assertAtomicFrameWrites(terminal.getChunks());

		tui.stop();
	});

	it("emits show cursor bytes exactly once when hardware cursor visibility is enabled", async () => {
		const { terminal, tui, component } = await startHiddenCursorTui();

		// given
		await renderNextFrame(tui, terminal, component);

		// when
		tui.setShowHardwareCursor(true);
		await terminal.waitForRender();
		await renderNextFrame(tui, terminal, component);

		// then
		assert.strictEqual(countOccurrences(outputText(terminal.getChunks()), SHOW_CURSOR), 1);

		tui.stop();
	});

	it("removes a focused Input fake cursor when the hardware cursor is visible", async () => {
		const terminal = new LoggingVirtualTerminal(40, 6);
		const tui = new TUI(terminal, true);
		const input = new Input();
		input.setValue("한글");
		input.handleInput("\x05");
		tui.addChild(input);
		tui.setFocus(input);

		tui.start();
		await terminal.waitForRender();

		const rendered = outputText(terminal.getChunks());
		assert.doesNotMatch(rendered, /\x1b\[7m/);
		assert.strictEqual(terminal.getCursorPosition().x, 6);
		const [line] = await terminal.flushAndGetViewport();
		assert.strictEqual(line?.trimEnd(), "> 한글");

		tui.stop();
	});

	it("preserves cursor content and surrounding styles when removing fake cursor styling", async () => {
		const terminal = new LoggingVirtualTerminal(40, 6);
		const tui = new TUI(terminal, true);
		const component = new StyledCursorComponent();
		tui.addChild(component);
		tui.setFocus(component);

		tui.start();
		await terminal.waitForRender();

		const rendered = outputText(terminal.getChunks());
		assert.ok(rendered.includes("\x1b[1;31mA한B\x1b[0m"));
		assert.doesNotMatch(rendered, /\x1b\[(?:7|27)m/);
		const [line] = await terminal.flushAndGetViewport();
		assert.strictEqual(line?.trimEnd(), "A한B");

		tui.stop();
	});

	it("keeps visible-to-hidden cursor mode toggles inside the replacement frame", async () => {
		const terminal = new LoggingVirtualTerminal(40, 6);
		const tui = new TUI(terminal, true);
		const input = new Input();
		input.setValue("한글");
		input.handleInput("\x05");
		tui.addChild(input);
		tui.setFocus(input);
		tui.start();
		await terminal.waitForRender();
		const chunkCountBeforeToggle = terminal.getChunks().length;

		tui.setShowHardwareCursor(false);
		await terminal.waitForRender();

		const toggleChunks = terminal.getChunks().slice(chunkCountBeforeToggle);
		assert.deepStrictEqual(
			toggleChunks.map((chunk) => chunk.kind),
			["write"],
		);
		const [toggleFrame] = toggleChunks;
		assert.ok(toggleFrame);
		assert.ok(toggleFrame.data.includes(FRAME_BEGIN));
		assert.ok(toggleFrame.data.includes("\x1b[7m"));
		assert.ok(toggleFrame.data.includes(HIDE_CURSOR));
		assert.ok(toggleFrame.data.indexOf(HIDE_CURSOR) < toggleFrame.data.indexOf(FRAME_END));

		tui.stop();
	});

	it("does not erase content under a visible hardware cursor when stopping", async () => {
		const terminal = new LoggingVirtualTerminal(40, 6);
		const tui = new TUI(terminal, true);
		const input = new Input();
		input.setValue("abc");
		input.handleInput("\x1b[C");
		tui.addChild(input);
		tui.setFocus(input);
		tui.start();
		await terminal.waitForRender();

		const [beforeStop] = await terminal.flushAndGetViewport();
		tui.stop();
		const [afterStop] = await terminal.flushAndGetViewport();

		assert.strictEqual(beforeStop?.trimEnd(), "> abc");
		assert.strictEqual(afterStop?.trimEnd(), "> abc");
	});

	it("does not erase content when a hide-cursor replacement frame is still pending", async () => {
		const terminal = new LoggingVirtualTerminal(40, 6);
		const tui = new TUI(terminal, true);
		const input = new Input();
		input.setValue("abc");
		input.handleInput("\x1b[C");
		tui.addChild(input);
		tui.setFocus(input);
		tui.start();
		await terminal.waitForRender();

		tui.setShowHardwareCursor(false);
		tui.stop();
		const [afterStop] = await terminal.flushAndGetViewport();

		assert.strictEqual(afterStop?.trimEnd(), "> abc");
	});

	it("reasserts hidden cursor visibility on the first frame after restart", async () => {
		const { terminal, tui, component } = await startHiddenCursorTui();

		// given
		await renderNextFrame(tui, terminal, component);
		tui.stop();
		const hideBytesBeforeRestart = countOccurrences(outputText(terminal.getChunks()), HIDE_CURSOR);

		// when
		tui.start();
		await terminal.waitForRender();

		// then
		const hideBytesAfterRestart = countOccurrences(outputText(terminal.getChunks()), HIDE_CURSOR);
		assert.strictEqual(hideBytesAfterRestart, hideBytesBeforeRestart + 1);

		tui.stop();
	});
});
