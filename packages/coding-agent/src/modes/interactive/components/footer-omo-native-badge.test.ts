import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { initTheme } from "../theme/theme.ts";
import { FooterComponent } from "./footer.ts";

// The badge is the only visible marker that a session is running the omo native distribution, so it is
// pinned here at the render() boundary: emoji, wording, and bottom-left anchoring all matter to users.
const OMO_NATIVE_BADGE = "(😺 OmO Native)";

function footerData(isOmoNative: boolean): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => undefined,
		getExtensionStatuses: () => [],
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
		isOmoNative: () => isOmoNative,
	} as unknown as ReadonlyFooterDataProvider;
}

function session(): AgentSession {
	return {
		state: { model: undefined, thinkingLevel: "off" },
		sessionManager: {
			getCwd: () => "/tmp/omo-footer-fixture",
			getSessionName: () => undefined,
			getUsageTotals: () => ({ cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined }),
		},
		getContextUsage: () => undefined,
		isFastModeActive: () => false,
		modelRuntime: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

function renderFooter(isOmoNative: boolean): string {
	return new FooterComponent(session(), footerData(isOmoNative)).render(200).join("\n");
}

describe("footer omo native badge", () => {
	beforeAll(() => initTheme("dark"));

	describe("#given a session running the omo native distribution", () => {
		it("#when the footer renders #then the cat badge appears", () => {
			expect(renderFooter(true)).toContain(OMO_NATIVE_BADGE);
		});

		it("#when the footer renders #then the badge leads the left anchor row", () => {
			const line = renderFooter(true);
			const badgeAt = line.indexOf(OMO_NATIVE_BADGE);
			const cwdAt = line.indexOf("omo-footer-fixture");
			expect(badgeAt).toBeGreaterThanOrEqual(0);
			expect(badgeAt).toBeLessThan(cwdAt);
		});
	});

	describe("#given a session that is not omo native", () => {
		it("#when the footer renders #then no badge appears", () => {
			expect(renderFooter(false)).not.toContain("OmO Native");
		});
	});
});
