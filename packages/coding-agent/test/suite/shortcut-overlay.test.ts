import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { formatKeyText } from "../../src/modes/interactive/components/keybinding-hints.ts";
import {
	classifyEditorInput,
	ShortcutOverlay,
	shouldShowShortcutOverlay,
} from "../../src/modes/interactive/components/shortcut-overlay.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

describe("classifyEditorInput", () => {
	it("classifies a signalled clipboard paste as paste even for a single character", () => {
		// A bracketed paste of exactly "?" into an empty editor grows the text by one
		// character, so length alone cannot distinguish it from typing.
		expect(classifyEditorInput("", "?", true)).toBe("paste");
	});

	it("classifies a single typed character as typed", () => {
		expect(classifyEditorInput("", "?", false)).toBe("typed");
	});

	it("classifies a multi-character jump as paste without an explicit signal", () => {
		expect(classifyEditorInput("", "hello", false)).toBe("paste");
	});

	it("keeps the overlay closed for a pasted question mark end to end", () => {
		const kind = classifyEditorInput("", "?", true);
		expect(shouldShowShortcutOverlay("", "?", kind)).toBe(false);
	});
});

describe("shouldShowShortcutOverlay", () => {
	it("shows for a typed question mark in an empty editor", () => {
		expect(shouldShowShortcutOverlay("", "?", "typed")).toBe(true);
	});

	it("does not show when the question mark follows existing text", () => {
		expect(shouldShowShortcutOverlay("a", "a?", "typed")).toBe(false);
	});

	it("does not show for a second typed question mark", () => {
		expect(shouldShowShortcutOverlay("?", "??", "typed")).toBe(false);
	});

	it("does not show when the question mark is deleted", () => {
		expect(shouldShowShortcutOverlay("?", "", "typed")).toBe(false);
	});

	it("does not show for a pasted question mark", () => {
		expect(shouldShowShortcutOverlay("", "?", "paste")).toBe(false);
	});

	it("does not show for other input kinds", () => {
		expect(shouldShowShortcutOverlay("", "?", "other")).toBe(false);
	});
});

describe("ShortcutOverlay", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders live keybindings and the help reference", () => {
		const keybindings = new KeybindingsManager({ "app.model.cycleForward": "ctrl+y" });
		setKeybindings(keybindings);

		const output = stripAnsi(new ShortcutOverlay().render(120).join("\n"));
		const interruptKey = formatKeyText(keybindings.getKeys("app.interrupt").join("/"));

		expect(output).toContain("ctrl+y next model");
		expect(output).not.toContain("ctrl+p next model");
		expect(output).toContain(`${interruptKey} interrupt`);
		expect(output).toContain("/help");
	});
});
