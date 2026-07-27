import { describe, expect, it } from "vitest";
import {
	allAccountsBlockedGuidance,
	missingBinaryGuidance,
	noAccountGuidance,
	sdkErrorGuidance,
} from "../src/core/extensions/builtin/claude-agent-sdk/guidance.ts";

describe("claude-agent-sdk auth guidance", () => {
	it("no-account guidance lists login, env tokens and ambient cli hints", () => {
		const text = noAccountGuidance(false);
		expect(text).toContain("/login claude-agent-sdk");
		expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN");
		expect(text).toContain("claude CLI");
	});

	it("no-account guidance mentions import when an anthropic credential exists", () => {
		expect(noAccountGuidance(true)).toContain("import");
	});

	it("all-blocked guidance includes the soonest unblock ETA", () => {
		const eta = Date.UTC(2026, 6, 28, 12, 0, 0);
		const text = allAccountsBlockedGuidance(eta);
		expect(text).toContain(new Date(eta).toISOString());
		expect(text).toContain("/claude-account list");
	});

	it("all-blocked guidance without a timestamp points at re-login", () => {
		expect(allAccountsBlockedGuidance(undefined)).toContain("re-login");
	});

	it("maps org_not_allowed, billing and auth_error to actionable messages", () => {
		expect(sdkErrorGuidance("org_not_allowed")).toContain("organization");
		expect(sdkErrorGuidance("billing")).toContain("billing");
		expect(sdkErrorGuidance("auth_error")).toContain("/login claude-agent-sdk");
		expect(sdkErrorGuidance("rate_limit")).toBeUndefined();
	});

	it("missing binary guidance names both remedies", () => {
		const text = missingBinaryGuidance("darwin", "arm64");
		expect(text).toContain("darwin-arm64");
		expect(text).toContain("--omit=optional");
		expect(text).toContain("CLAUDE_CODE_EXECUTABLE");
	});
});
