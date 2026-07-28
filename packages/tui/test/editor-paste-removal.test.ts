import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(): Editor {
	return new Editor(new TUI(new VirtualTerminal(120, 30)), defaultEditorTheme);
}

function largePaste(prefix: string): string {
	return Array.from({ length: 12 }, (_, index) => `${prefix}-${index + 1}`).join("\n");
}

function paste(editor: Editor, content: string): string {
	editor.handleInput(`\x1b[200~${content}\x1b[201~`);
	return editor.getText();
}

describe("paste marker removal bookkeeping", () => {
	it("forward delete clears the removed marker registry entry", () => {
		const editor = createEditor();
		const body = largePaste("PRIVATE");
		const marker = paste(editor, body);

		editor.handleInput("\x01"); // Ctrl+A
		editor.handleInput("\x04"); // Ctrl+D
		assert.strictEqual(editor.getText(), "");

		for (const char of marker) editor.handleInput(char);

		assert.strictEqual(editor.getExpandedText(), marker);
		assert.strictEqual(editor.getPasteState().pastes.size, 0);
	});

	it("kill and yank intentionally retains marker expansion", () => {
		const editor = createEditor();
		const body = largePaste("YANK");
		paste(editor, body);

		editor.handleInput("\x01"); // Ctrl+A
		editor.handleInput("\x0b"); // Ctrl+K
		assert.strictEqual(editor.getText(), "");
		assert.strictEqual(editor.getPasteState().pastes.size, 1);

		editor.handleInput("\x19"); // Ctrl+Y

		assert.strictEqual(editor.getExpandedText(), body);
		assert.strictEqual(editor.getPasteState().pastes.size, 1);
	});
});
