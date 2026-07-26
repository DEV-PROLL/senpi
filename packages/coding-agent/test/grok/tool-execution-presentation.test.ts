import { TUI } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const fg = (rgb: string, text: string) => `\x1b[38;2;${rgb}m${text}\x1b[39m`;

describe("ToolExecutionComponent grok presentation", () => {
	beforeEach(() => {
		initTheme("grok-night", false);
	});

	it("uses the optional grok presentation without changing the default classic constructor contract", () => {
		const component = new ToolExecutionComponent(
			"write",
			"call-1",
			{ path: "note.txt" },
			{},
			undefined,
			new TUI(new VirtualTerminal(80, 24)),
			"/tmp",
			"grok",
		);
		try {
			expect(component.render(80)).toEqual([
				"",
				`${fg("108;108;108", "┃")} ${fg("224;175;104", "⠹")} ${fg("225;225;225", "write")}`,
			]);
		} finally {
			component.dispose();
		}
	});
});
