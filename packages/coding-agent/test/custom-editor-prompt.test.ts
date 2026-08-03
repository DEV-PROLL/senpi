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

describe("CustomEditor prompt marker", () => {
	it("shows an accent chevron and aligns wrapped rows", () => {
		const editor = new CustomEditor(new TUI(new VirtualTerminal(12, 24)), editorTheme, new KeybindingsManager());
		editor.setText("abcdefghij");
		editor.setPaddingX(0);

		const rendered = editor.render(12);

		expect(editor.getPaddingX()).toBe(0);
		expect(rendered[1]?.startsWith(`${accent("❯")} abcdefgh`)).toBe(true);
		expect(rendered[2]).toMatch(/^ {2}ij/);
		expect(rendered.map((line) => visibleWidth(line))).toEqual([12, 12, 12, 12]);
	});
});
