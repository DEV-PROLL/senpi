import { describe, expect, it } from "vitest";
import {
	allAccountsBlockedGuidance,
	missingBinaryGuidance,
	noAccountGuidance,
	presetAppendDeprecationGuidance,
	resetPresetAppendDeprecation,
	sdkErrorGuidance,
} from "../src/core/extensions/builtin/claude-sdk-oauth/guidance.ts";

describe("claude-sdk-oauth auth guidance", () => {
	it("no-account guidance lists login, env tokens and ambient cli hints", () => {
		const text = noAccountGuidance(false);
		expect(text).toContain("/login claude-sdk-oauth");
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
		expect(sdkErrorGuidance("auth_error")).toContain("/login claude-sdk-oauth");
		expect(sdkErrorGuidance("rate_limit")).toBeUndefined();
	});

	it("missing binary guidance names both remedies", () => {
		const text = missingBinaryGuidance("darwin", "arm64");
		expect(text).toContain("darwin-arm64");
		expect(text).toContain("--omit=optional");
		expect(text).toContain("CLAUDE_CODE_EXECUTABLE");
	});
});

describe("preset-append deprecation guidance", () => {
	it("emits a notice for preset-append mode", () => {
		resetPresetAppendDeprecation();
		const text = presetAppendDeprecationGuidance({ mode: "preset-append" });
		expect(text).toContain("deprecated");
		expect(text).toContain("preset-append");
		expect(text).toContain("full");
		expect(text).toContain("removed");
	});

	it("returns undefined for full mode", () => {
		resetPresetAppendDeprecation();
		expect(presetAppendDeprecationGuidance({ mode: "full" })).toBeUndefined();
	});

	it("returns undefined for override mode", () => {
		resetPresetAppendDeprecation();
		expect(presetAppendDeprecationGuidance({ mode: "override" })).toBeUndefined();
	});

	it("emits at most once per session", () => {
		resetPresetAppendDeprecation();
		const first = presetAppendDeprecationGuidance({ mode: "preset-append" });
		const second = presetAppendDeprecationGuidance({ mode: "preset-append" });
		expect(first).toContain("deprecated");
		expect(second).toBeUndefined();
	});

	it("includes the extra sentence when conflict is true", () => {
		resetPresetAppendDeprecation();
		const text = presetAppendDeprecationGuidance({ mode: "preset-append", conflict: true });
		expect(text).toContain("systemPromptMode");
		expect(text).toContain("wins");
	});

	it("reset re-arms the once-per-session guard", () => {
		resetPresetAppendDeprecation();
		const first = presetAppendDeprecationGuidance({ mode: "preset-append" });
		const suppressed = presetAppendDeprecationGuidance({ mode: "preset-append" });
		expect(first).toContain("deprecated");
		expect(suppressed).toBeUndefined();
		resetPresetAppendDeprecation();
		const reArmed = presetAppendDeprecationGuidance({ mode: "preset-append" });
		expect(reArmed).toContain("deprecated");
	});
});
