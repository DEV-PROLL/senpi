import { Editor, type EditorComponent, type EditorPasteState, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { Container, TUI } from "../../tui/src/tui.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { EditorFactory } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * Regression: switching editors (extension custom editor <-> default editor)
 * must not orphan large-paste markers. A destination editor without a paste
 * registry would keep the literal `[paste #N +M lines]` marker and silently
 * drop the pasted body from the submitted prompt.
 */

type SetCustomEditorComponentThis = {
	editorComponentFactory: EditorFactory | undefined;
	editor: EditorComponent;
	defaultEditor: Editor;
	editorContainer: Container;
	chrome: undefined;
	autocompleteProvider: undefined;
	keybindings: KeybindingsManager;
	ui: TUI;
};

function callSetCustomEditorComponent(
	fakeThis: SetCustomEditorComponentThis,
	factory: EditorFactory | undefined,
): void {
	const descriptor = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "setCustomEditorComponent");
	const setCustomEditorComponent = descriptor?.value as
		| ((this: SetCustomEditorComponentThis, factory: EditorFactory | undefined) => void)
		| undefined;
	if (!setCustomEditorComponent) {
		throw new Error("setCustomEditorComponent is missing");
	}
	setCustomEditorComponent.call(fakeThis, factory);
}

const PASTE_BODY = Array.from({ length: 18 }, (_, i) => `PASTE-BODY-LINE-${i + 1}`).join("\n");
const BRACKETED_PASTE = `\x1b[200~${PASTE_BODY}\x1b[201~`;

function makeFakeThis(): SetCustomEditorComponentThis {
	const ui = new TUI(new VirtualTerminal(120, 34));
	const defaultEditor = new Editor(ui, getEditorTheme());
	const fakeThis: SetCustomEditorComponentThis = {
		editorComponentFactory: undefined,
		editor: defaultEditor,
		defaultEditor,
		editorContainer: new Container(),
		chrome: undefined,
		autocompleteProvider: undefined,
		keybindings: new KeybindingsManager(),
		ui,
	};
	fakeThis.editorContainer.addChild(defaultEditor);
	return fakeThis;
}

/** Minimal custom editor without paste-state support (plain EditorComponent contract). */
class PlainEditorComponent implements EditorComponent {
	focused = false;
	private text = "";
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	handleInput(_data: string): void {}

	render(): string[] {
		return [this.text];
	}

	invalidate(): void {}
}

describe("InteractiveMode.setCustomEditorComponent paste transfer", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	test("transfers the paste registry to a paste-aware custom editor (markers stay collapsed)", () => {
		const fakeThis = makeFakeThis();
		fakeThis.defaultEditor.handleInput(BRACKETED_PASTE);
		expect(fakeThis.defaultEditor.getText()).toMatch(/\[paste #1 \+\d+ lines\]/);

		const factory: EditorFactory = (tui, theme) => new Editor(tui as TUI, theme);
		callSetCustomEditorComponent(fakeThis, factory);

		const custom = fakeThis.editor as Editor;
		expect(custom).not.toBe(fakeThis.defaultEditor);
		// Marker stays collapsed (no UX regression) and still expands to the body
		expect(custom.getText()).toMatch(/\[paste #1 \+\d+ lines\]/);
		expect(custom.getExpandedText()).toBe(PASTE_BODY);

		// Submit through the wired onSubmit sends the full body, not the marker
		let submitted = "";
		custom.onSubmit = (text) => {
			submitted = text;
		};
		custom.handleInput("\r");
		expect(submitted).toBe(PASTE_BODY);
		expect(submitted).not.toContain("[paste #");
	});

	test("falls back to expanded text for a custom editor without paste-state support", () => {
		const fakeThis = makeFakeThis();
		fakeThis.defaultEditor.handleInput(BRACKETED_PASTE);

		const plain = new PlainEditorComponent();
		callSetCustomEditorComponent(fakeThis, () => plain);

		expect(fakeThis.editor).toBe(plain);
		// The plain editor cannot expand markers, so it must receive the body
		expect(plain.getText()).toBe(PASTE_BODY);
		expect(plain.getText()).not.toContain("[paste #");
	});

	test("restores the paste registry when switching back to the default editor", () => {
		const fakeThis = makeFakeThis();
		fakeThis.defaultEditor.handleInput(BRACKETED_PASTE);

		callSetCustomEditorComponent(fakeThis, (tui, theme) => new Editor(tui as TUI, theme));
		callSetCustomEditorComponent(fakeThis, undefined);

		expect(fakeThis.editor).toBe(fakeThis.defaultEditor);
		expect(fakeThis.defaultEditor.getText()).toMatch(/\[paste #1 \+\d+ lines\]/);
		expect(fakeThis.defaultEditor.getExpandedText()).toBe(PASTE_BODY);
	});

	test("round-trip through a plain editor keeps the pasted body (as literal text)", () => {
		const fakeThis = makeFakeThis();
		fakeThis.defaultEditor.handleInput(BRACKETED_PASTE);

		callSetCustomEditorComponent(fakeThis, () => new PlainEditorComponent());
		callSetCustomEditorComponent(fakeThis, undefined);

		// Body was expanded on the way out and survives the way back
		expect(fakeThis.defaultEditor.getText()).toBe(PASTE_BODY);
	});

	test("transferred paste state snapshots are content-exact (EditorPasteState contract)", () => {
		const fakeThis = makeFakeThis();
		fakeThis.defaultEditor.handleInput(BRACKETED_PASTE);

		const state: EditorPasteState = fakeThis.defaultEditor.getPasteState();
		expect(state.pastes.get(1)).toBe(PASTE_BODY);
		expect(state.pasteCounter).toBe(1);
	});
});
