import {
	type Component,
	type EditorOptions,
	type EditorTheme,
	type OverlayOptions,
	Spacer,
	type TUI,
} from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { CustomEditor } from "../components/custom-editor.ts";
import { WorkingStatusIndicator } from "../components/status-indicator.ts";
import type { ToolExecutionPresentation } from "../components/tool-execution.ts";
import { theme } from "../theme/theme.ts";
import { getGrokChromeTokens } from "./chrome-tokens.ts";
import { GrokFooter } from "./footer.ts";
import { GrokInputCard } from "./input-card.ts";
import { GROK_GLYPHS } from "./palette.ts";
import { GrokWelcomeCard } from "./welcome-card.ts";

export interface InteractiveFooter extends Component {
	setSession(session: AgentSession): void;
	setAutoCompactEnabled(enabled: boolean): void;
	invalidate(): void;
	dispose(): void;
}

export type EditorBorderContext = {
	readonly isBashMode: boolean;
	readonly thinkingLevel: string;
};

/**
 * Mode-owned chrome seam for InteractiveMode. Extensions continue to own their
 * editor factory; this strategy only creates and decorates the base editor.
 */
export interface InteractiveChrome {
	readonly toolPresentation: ToolExecutionPresentation;
	createBaseEditor(context: { ui: TUI; keybindings: KeybindingsManager; editorOptions: EditorOptions }): CustomEditor;
	getEditorTheme(): EditorTheme;
	createFooter(session: AgentSession, footerData: ReadonlyFooterDataProvider): InteractiveFooter;
	createWelcomeContent(appName: string, version: string): Component;
	createWorkingIndicator(ui: TUI, message: string, indicator?: WorkingIndicatorOptions): WorkingStatusIndicator;
	getEditorBorderColor(context: EditorBorderContext): (text: string) => string;
	decorateOverlay(options: OverlayOptions | undefined): OverlayOptions | undefined;
	arrangeRoot(children: readonly Component[]): Component[];
}

class GrokEditor extends CustomEditor {
	private readonly card: GrokInputCard;

	constructor(ui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, options: EditorOptions) {
		super(ui, editorTheme, keybindings, options);
		this.card = new GrokInputCard({
			render: (width) => this.renderBase(width),
			invalidate: () => super.invalidate(),
		});
	}

	override render(width: number): string[] {
		return this.card.render(width);
	}

	private renderBase(width: number): string[] {
		return super.render(width);
	}
}

export class GrokChrome implements InteractiveChrome {
	readonly toolPresentation = "grok" as const;

	createBaseEditor({
		ui,
		keybindings,
		editorOptions,
	}: {
		ui: TUI;
		keybindings: KeybindingsManager;
		editorOptions: EditorOptions;
	}): CustomEditor {
		return new GrokEditor(ui, this.getEditorTheme(), keybindings, editorOptions);
	}

	getEditorTheme(): EditorTheme {
		const tokens = getGrokChromeTokens();
		return {
			borderColor: tokens.inputBorder,
			selectList: {
				selectedPrefix: (text) => tokens.primaryText(text),
				selectedText: (text) => tokens.primaryText(text),
				description: (text) => tokens.mutedText(text),
				scrollInfo: (text) => tokens.mutedText(text),
				noMatch: (text) => tokens.mutedText(text),
				renderRow: ({ prefix, primary, description, isSelected }) => {
					const row = `${prefix}${tokens.primaryText(primary)}${description ? tokens.mutedText(description) : ""}`;
					return isSelected ? theme.bg("selectedBg", row) : row;
				},
			},
		};
	}

	createFooter(session: AgentSession, footerData: ReadonlyFooterDataProvider): InteractiveFooter {
		return new GrokFooter(session, footerData);
	}

	createWelcomeContent(appName: string, version: string): Component {
		return new GrokWelcomeCard(appName, version);
	}

	createWorkingIndicator(ui: TUI, message: string, indicator?: WorkingIndicatorOptions): WorkingStatusIndicator {
		return new WorkingStatusIndicator(ui, message, {
			...indicator,
			frames: [GROK_GLYPHS.spinner],
			indicatorFormatter: (frame) => theme.fg("accent", frame),
		});
	}

	getEditorBorderColor(_context: EditorBorderContext): (text: string) => string {
		return getGrokChromeTokens().inputBorder;
	}

	decorateOverlay(options: OverlayOptions | undefined): OverlayOptions | undefined {
		// Existing overlays own their geometry and border components. The grok
		// policy deliberately preserves that geometry and lets active-theme tokens
		// supply their surface colors; G6 adds a dedicated modal shell if needed.
		return options;
	}

	arrangeRoot(children: readonly Component[]): Component[] {
		// pi-tui concatenates root children; it has no absolute positioning. Keep
		// transcript/status content first, insert one fixed spacer, then append the
		// input card, widgets below it, and footer as the tail. As transcript output
		// grows this tail is pushed to the terminal's lower edge deterministically.
		const inputTailStart = Math.max(0, children.length - 3);
		return [...children.slice(0, inputTailStart), new Spacer(1), ...children.slice(inputTailStart)];
	}
}
