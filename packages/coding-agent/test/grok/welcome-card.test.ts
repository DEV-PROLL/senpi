import { beforeEach, describe, expect, it } from "vitest";
import { GrokWelcomeCard } from "../../src/modes/interactive/grok/welcome-card.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const fg = (rgb: string, text: string) => `\x1b[38;2;${rgb}m${text}\x1b[39m`;
const bg = (rgb: string, text: string) => `\x1b[48;2;${rgb}m${text}\x1b[49m`;

describe("GrokWelcomeCard", () => {
	beforeEach(() => {
		initTheme("grok-night", false);
	});

	it("resolves the card border from the active theme", () => {
		const card = new GrokWelcomeCard("senpi", "9.9.9");
		expect(card.render(30)).toEqual([
			fg("51;51;51", "╭────────────────────────────╮"),
			`${fg("51;51;51", "│")}${bg("17;17;17", ` ${fg("225;225;225", "senpi v9.9.9")}               `)}${fg("51;51;51", "│")}`,
			`${fg("51;51;51", "│")}${bg("17;17;17", " Ready for your next task.  ")}${fg("51;51;51", "│")}`,
			fg("51;51;51", "╰────────────────────────────╯"),
		]);
	});
});
