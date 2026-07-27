import { type Component, type Focusable, Markdown, type MarkdownTheme, type OverlayOptions } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../keybindings.ts";
import type { Theme } from "../../../../modes/interactive/theme/theme.ts";

export const HELP_OVERLAY_MARGIN = 2;
export const HELP_OVERLAY_OPTIONS = {
	anchor: "top-center",
	width: "90%",
	minWidth: 60,
	maxHeight: "100%",
	margin: HELP_OVERLAY_MARGIN,
} as const satisfies OverlayOptions;

type HelpPanelOptions = {
	readonly markdown: string;
	readonly tui: {
		readonly terminal: { readonly rows: number };
		requestRender(): void;
	};
	readonly theme: Theme;
	readonly keybindings: KeybindingsManager;
	readonly done: (result: void) => void;
};

function createMarkdownTheme(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
	};
}

export class HelpPanel implements Component, Focusable {
	private readonly markdown: Markdown;
	private readonly options: HelpPanelOptions;
	private offset = 0;
	private renderedLineCount = 0;
	private _focused = false;

	constructor(options: HelpPanelOptions) {
		this.options = options;
		this.markdown = new Markdown(options.markdown, 1, 0, createMarkdownTheme(options.theme));
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	render(width: number): string[] {
		const lines = this.markdown.render(width);
		this.renderedLineCount = lines.length;
		this.offset = Math.min(this.offset, this.maxOffset());
		return lines.slice(this.offset, this.offset + this.viewportHeight());
	}

	handleInput(data: string): void {
		const { keybindings } = this.options;
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.options.done();
			return;
		}

		const previousOffset = this.offset;
		if (keybindings.matches(data, "tui.select.up")) {
			this.offset = Math.max(0, this.offset - 1);
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.offset = Math.min(this.maxOffset(), this.offset + 1);
		} else if (keybindings.matches(data, "tui.select.pageUp")) {
			this.offset = Math.max(0, this.offset - this.viewportHeight());
		} else if (keybindings.matches(data, "tui.select.pageDown")) {
			this.offset = Math.min(this.maxOffset(), this.offset + this.viewportHeight());
		}

		if (this.offset !== previousOffset) this.options.tui.requestRender();
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	private viewportHeight(): number {
		return Math.max(1, this.options.tui.terminal.rows - HELP_OVERLAY_MARGIN * 2);
	}

	private maxOffset(): number {
		return Math.max(0, this.renderedLineCount - this.viewportHeight());
	}
}
