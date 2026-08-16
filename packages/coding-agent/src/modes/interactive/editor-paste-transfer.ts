import { type EditorComponent, expandPasteMarkers } from "@earendil-works/pi-tui";

export function transferEditorContent(source: EditorComponent, target: EditorComponent): void {
	const rawText = source.getText();
	const pasteState = source.getPasteState?.();
	if (pasteState && target.getPasteState && target.setPasteState) {
		target.setText(rawText);
		target.setPasteState(pasteState);
	} else {
		target.setText(source.getExpandedText?.() ?? (pasteState ? expandPasteMarkers(rawText, pasteState) : rawText));
	}
}

export function expandEditorSubmission(editor: EditorComponent, text: string): string {
	const pasteState = editor.getPasteState?.();
	return editor.getExpandedText?.() ?? (pasteState ? expandPasteMarkers(text, pasteState) : text);
}

/**
 * Expand a submitted editor value. Unlike {@link expandEditorSubmission},
 * which reads the live draft, this never consults the editor's current
 * content: pi-tui's `Editor.submitValue()` clears the editor state and paste
 * registry *before* invoking `onSubmit`, so re-reading the editor here (via
 * `getExpandedText()`) yields "" and silently drops the submission for any
 * custom editor that implements `getExpandedText()`.
 */
export function expandSubmittedText(editor: EditorComponent, text: string): string {
	const pasteState = editor.getPasteState?.();
	return pasteState ? expandPasteMarkers(text, pasteState) : text;
}
