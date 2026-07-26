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
