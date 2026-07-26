import { beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../src/core/footer-data-provider.ts";
import { GrokFooter } from "../../src/modes/interactive/grok/footer.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const fg = (rgb: string, text: string) => `\x1b[38;2;${rgb}m${text}\x1b[39m`;

const session = {
	state: { model: { id: "faux-1" } },
	sessionManager: { getCwd: () => "/workspace/project" },
} as unknown as AgentSession;

const footerData = {
	getGitBranch: () => null,
	getExtensionStatuses: () => new Map(),
	getAvailableProviderCount: () => 0,
	onBranchChange: () => () => {},
} as ReadonlyFooterDataProvider;

describe("GrokFooter", () => {
	beforeEach(() => {
		initTheme("grok-night", false);
	});

	it("resolves the model label and cwd from active-theme chrome tokens", () => {
		const footer = new GrokFooter(session, footerData);
		expect(footer.render(80)).toEqual([`${fg("88;88;88", "/workspace/project")} ${fg("128;128;128", "faux-1")}`]);
	});
});
