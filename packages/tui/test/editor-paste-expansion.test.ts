import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(): Editor {
	return new Editor(new TUI(new VirtualTerminal(120, 30)), defaultEditorTheme);
}

function largePaste(prefix: string, lines = 12): string {
	return Array.from({ length: lines }, (_, index) => `${prefix}-${index + 1}`).join("\n");
}

function paste(editor: Editor, content: string): string {
	editor.handleInput(`\x1b[200~${content}\x1b[201~`);
	return editor.getText();
}

describe("paste marker expansion authorization", () => {
	it("does not expand duplicate canonical marker copies", () => {
		const editor = createEditor();
		const body = largePaste("SECRET");
		const marker = paste(editor, body);

		editor.setText(`${marker} LITERAL-COPY ${marker}`);

		assert.strictEqual(editor.getExpandedText(), `${marker} LITERAL-COPY ${marker}`);
	});

	it("does not expand a queued prefix that duplicates the canonical marker", () => {
		const editor = createEditor();
		const body = largePaste("QUEUE-BODY");
		const marker = paste(editor, body);

		editor.setText(`queued ${marker}\n\n${marker}`);

		assert.strictEqual(editor.getExpandedText(), `queued ${marker}\n\n${marker}`);
	});

	it("expands over the original text without recursively expanding pasted bodies", () => {
		const editor = createEditor();
		const secondBody = largePaste("SECOND");
		const secondMarker = "[paste #2 +12 lines]";
		const firstBody = `${secondMarker}\n${largePaste("FIRST", 11)}`;

		const firstMarker = paste(editor, firstBody);
		editor.handleInput(" ");
		paste(editor, secondBody);

		assert.strictEqual(editor.getExpandedText(), `${firstBody} ${secondBody}`);
		assert.ok(editor.getExpandedText().startsWith(secondMarker));
		assert.strictEqual(editor.getExpandedText().split("SECOND-1\n").length - 1, 1);
		assert.match(firstMarker, /^\[paste #1 \+12 lines\]$/);
	});
});
