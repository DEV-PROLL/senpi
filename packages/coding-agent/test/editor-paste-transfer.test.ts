import type { EditorComponent, EditorPasteState } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { expandEditorSubmission, expandSubmittedText } from "../src/modes/interactive/editor-paste-transfer.ts";

function fakeEditor(overrides: Partial<EditorComponent> = {}): EditorComponent {
	let text = "";
	return {
		render: () => [],
		invalidate: () => {},
		handleInput: () => {},
		getText: () => text,
		setText: (next: string) => {
			text = next;
		},
		...overrides,
	} as EditorComponent;
}

describe("expandSubmittedText", () => {
	it("keeps the submitted text when the editor was already cleared", () => {
		// pi-tui Editor.submitValue() clears the editor state and paste registry
		// BEFORE calling onSubmit(result). A custom editor whose getExpandedText()
		// re-reads live content therefore reports "" at submit time; the submit
		// path must trust the passed text instead of re-reading the editor.
		const clearedEditor = fakeEditor({ getExpandedText: () => "" });
		expect(expandSubmittedText(clearedEditor, "the typed prompt")).toBe("the typed prompt");
	});

	it("expands paste markers in the submitted text via the paste registry", () => {
		const pasteState: EditorPasteState = {
			pastes: new Map([[1, "pasted body"]]),
			pasteCounter: 1,
		};
		const editor = fakeEditor({ getPasteState: () => pasteState });
		expect(expandSubmittedText(editor, "echo [paste #1 11 chars] done")).toBe("echo pasted body done");
	});

	it("passes the submitted text through without a paste registry", () => {
		expect(expandSubmittedText(fakeEditor(), "plain")).toBe("plain");
	});
});

describe("expandEditorSubmission (live draft reads)", () => {
	it("still prefers the editor's own expanded text", () => {
		const editor = fakeEditor({ getExpandedText: () => "live expanded draft" });
		expect(expandEditorSubmission(editor, "fallback text")).toBe("live expanded draft");
	});
});
