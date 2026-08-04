import { type EditorTheme, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

const accent = (text: string) => `\x1b[36m${text}\x1b[39m`;
const editorTheme: EditorTheme = {
	borderColor: accent,
	selectList: {
		selectedPrefix: (text) => text,
		selectedText: (text) => text,
		description: (text) => text,
		scrollInfo: (text) => text,
		noMatch: (text) => text,
	},
};

function plain(text: string): string {
	return text.replace(/\x1b\[[\d;]*m/g, "");
}

describe("CustomEditor prompt marker", () => {
	it("shows an accent chevron and aligns wrapped rows", () => {
		const editor = new CustomEditor(new TUI(new VirtualTerminal(12, 24)), editorTheme, new KeybindingsManager());
		editor.setText("abcdefghij");
		editor.setPaddingX(0);

		const rendered = editor.render(12);
		const plainRows = rendered.map(plain);
		const promptRow = plainRows.find((row) => row.includes("❯"));
		const wrappedRow = plainRows.find((row) => row.includes("ij"));

		expect(editor.getPaddingX()).toBe(0);
		expect(rendered.join("").split("❯")).toHaveLength(2);
		expect(promptRow?.indexOf("a")).toBeGreaterThan(0);
		expect(wrappedRow?.indexOf("i")).toBe(promptRow?.indexOf("a"));
		expect(rendered.every((line) => visibleWidth(line) <= 12)).toBe(true);
	});

	it("does not move the marker onto a scrolled continuation row", () => {
		const editor = new CustomEditor(new TUI(new VirtualTerminal(12, 10)), editorTheme, new KeybindingsManager());
		editor.setText(["one", "two", "three", "four", "five", "six"].join("\n"));

		const rendered = editor.render(12);

		expect(rendered[0]).toContain("↑");
		expect(rendered.join("")).not.toContain("❯");
	});
});
