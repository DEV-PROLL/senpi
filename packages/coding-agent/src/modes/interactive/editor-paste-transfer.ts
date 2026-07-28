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
