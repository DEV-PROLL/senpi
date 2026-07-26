import type { Component } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { getGrokChromeTokens } from "../../src/modes/interactive/grok/chrome-tokens.ts";
import { GrokInputCard } from "../../src/modes/interactive/grok/input-card.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const fg = (rgb: string, text: string) => `\x1b[38;2;${rgb}m${text}\x1b[39m`;
const bg = (rgb: string, text: string) => `\x1b[48;2;${rgb}m${text}\x1b[49m`;

const editor: Component = {
	render: () => ["draft"],
	invalidate: () => {},
};

describe("GrokInputCard", () => {
	beforeEach(() => {
		initTheme("grok-night", false);
	});

	it("resolves the grok-night input border and panel interior from active-theme chrome tokens", () => {
		const tokens = getGrokChromeTokens();
		expect(tokens.inputBorder("x")).toBe(fg("80;80;88", "x"));
		expect(tokens.inputInterior("x")).toBe(bg("17;17;17", "x"));
	});

	it("resolves day-theme chrome tokens instead of retaining grok-night literals", () => {
		initTheme("grok-day", false);
		const tokens = getGrokChromeTokens();
		expect(tokens.inputBorder("x")).toBe(fg("47;100;210", "x"));
		expect(tokens.inputInterior("x")).toBe(bg("255;255;255", "x"));
	});

	it("renders a rounded bordered card around the editor", () => {
		const card = new GrokInputCard(editor);
		expect(card.render(12)).toEqual([
			fg("80;80;88", "╭──────────╮"),
			`${fg("80;80;88", "│")}${bg("17;17;17", "draft     ")}${fg("80;80;88", "│")}`,
			fg("80;80;88", "╰──────────╯"),
		]);
	});
});
