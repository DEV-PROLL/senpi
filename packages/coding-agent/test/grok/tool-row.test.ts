import { beforeEach, describe, expect, it } from "vitest";
import { GrokToolRow } from "../../src/modes/interactive/grok/tool-row.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const fg = (rgb: string, text: string) => `\x1b[38;2;${rgb}m${text}\x1b[39m`;

describe("GrokToolRow", () => {
	beforeEach(() => {
		initTheme("grok-night", false);
	});

	it("renders guide and diamond glyphs with theme-backed success, error, and warning accents", () => {
		const success = new GrokToolRow({ toolName: "write", isPartial: false, result: { isError: false } });
		const error = new GrokToolRow({ toolName: "write", isPartial: false, result: { isError: true } });
		const warning = new GrokToolRow({ toolName: "write", isPartial: false });

		const prefix = `${fg("108;108;108", "┃")} `;
		const label = ` ${fg("225;225;225", "write")}`;
		expect(success.render(80)).toEqual([`${prefix}${fg("158;206;106", "◆")}${label}`]);
		expect(error.render(80)).toEqual([`${prefix}${fg("247;118;142", "◆")}${label}`]);
		expect(warning.render(80)).toEqual([`${prefix}${fg("224;175;104", "◆")}${label}`]);
	});

	it("uses the grok braille spinner frame while a tool is pending", () => {
		const row = new GrokToolRow({ toolName: "write", isPartial: true });
		expect(row.render(80)).toEqual([
			`${fg("108;108;108", "┃")} ${fg("224;175;104", "⠹")} ${fg("225;225;225", "write")}`,
		]);
	});
});
