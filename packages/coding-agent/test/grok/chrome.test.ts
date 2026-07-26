import { TUI } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { GrokChrome } from "../../src/modes/interactive/grok/chrome.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const fg = (rgb: string, text: string) => `\x1b[38;2;${rgb}m${text}\x1b[39m`;

function createRuntime(): AgentSessionRuntime {
	return {
		session: {
			autoCompactionEnabled: true,
			resourceLoader: { getThemes: () => ({ themes: [] }) },
			sessionManager: { getCwd: () => process.cwd() },
			settingsManager: {
				getAutocompleteMaxVisible: () => 5,
				getClearOnShrink: () => false,
				getEditorPaddingX: () => 0,
				getHideThinkingBlock: () => false,
				getOutputPad: () => 1,
				getShowHardwareCursor: () => false,
				getSmoothStreaming: () => false,
				getSmoothStreamingFps: () => 60,
				getThemeSetting: () => "grok-night",
			},
		},
		setBeforeSessionInvalidate: () => {},
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
}

describe("GrokChrome", () => {
	beforeEach(() => {
		initTheme("grok-night", false);
	});

	it("selects grok tool presentation and routes the input border through active-theme chrome tokens", () => {
		const chrome = new GrokChrome();
		expect(chrome.toolPresentation).toBe("grok");
		expect(chrome.getEditorBorderColor({ isBashMode: false, thinkingLevel: "high" })("─")).toBe(fg("80;80;88", "─"));
	});

	it("styles selected slash prefixes and rows through the active grok theme", () => {
		const chrome = new GrokChrome();
		const selectList = chrome.getEditorTheme().selectList;

		expect(selectList.selectedPrefix("→ ")).toBe(fg("122;162;247", "→ "));
		expect(selectList.renderRow?.({
			prefix: selectList.selectedPrefix("→ "),
			primary: "/model",
			description: "  Select model",
			isSelected: true,
		})).toBe(`\x1b[48;2;54;54;54m${fg("122;162;247", "→ ")}${fg("225;225;225", "/model")}${fg("108;108;108", "  Select model")}\x1b[49m`);

		initTheme("grok-day", false);
		const daySelectList = chrome.getEditorTheme().selectList;
		expect(daySelectList.selectedPrefix("→ ")).toBe(fg("47;100;210", "→ "));
		expect(daySelectList.renderRow?.({
			prefix: daySelectList.selectedPrefix("→ "),
			primary: "/model",
			isSelected: true,
		})).toBe(`\x1b[48;2;208;208;224m${fg("47;100;210", "→ ")}${fg("31;35;40", "/model")}\x1b[49m`);
	});

	it("renders the footer surface through the active grok theme", () => {
		const chrome = new GrokChrome();
		const footer = { render: () => ["footer"], invalidate: () => {} };
		const nightFooter = chrome.arrangeRoot([footer]).at(-1);
		expect(nightFooter?.render(80)).toEqual(["\x1b[48;2;20;20;20mfooter\x1b[49m"]);

		initTheme("grok-day", false);
		const dayFooter = chrome.arrangeRoot([footer]).at(-1);
		expect(dayFooter?.render(80)).toEqual(["\x1b[48;2;248;248;248mfooter\x1b[49m"]);
	});

	it("wires the grok braille spinner into working indicators", () => {
		const chrome = new GrokChrome();
		const indicator = chrome.createWorkingIndicator(new TUI(new VirtualTerminal(80, 24)), "Working");
		try {
			expect(indicator.render(80)).toEqual([
				"",
				` ${fg("122;162;247", "⠹")} ${fg("108;108;108", "Working")}${" ".repeat(70)}`,
			]);
		} finally {
			indicator.dispose();
		}
	});

	it("resolves the gate's grok option to the mode-owned strategy", () => {
		const mode = new InteractiveMode(createRuntime(), { chrome: "grok" });
		expect((mode as unknown as { chrome: unknown }).chrome).toBeInstanceOf(GrokChrome);
	});
});
