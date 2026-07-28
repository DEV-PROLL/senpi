import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createSession(): AgentSession {
	return {
		state: {
			model: { id: "test-model", provider: "test", contextWindow: 200_000, reasoning: false },
			thinkingLevel: "off",
		},
		sessionManager: {
			getUsageTotals: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				latestCacheHitRate: undefined,
			}),
			getSessionName: () => "test",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRuntime: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

function createFooterData(omoNative: boolean): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
		isOmoNative: () => omoNative,
	};
}

describe("FooterComponent (OmO Native) indicator", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("prepends (OmO Native) as the leftmost segment when isOmoNative is true", () => {
		const footer = new FooterComponent(createSession(), createFooterData(true));
		const lines = footer.render(120);
		const firstLine = lines[0] ?? "";
		expect(stripAnsi(firstLine).startsWith("(OmO Native)")).toBe(true);
	});

	it("omits (OmO Native) when isOmoNative is false", () => {
		const footer = new FooterComponent(createSession(), createFooterData(false));
		const lines = footer.render(120);
		const firstLine = lines[0] ?? "";
		expect(stripAnsi(firstLine).includes("(OmO Native)")).toBe(false);
	});
});
