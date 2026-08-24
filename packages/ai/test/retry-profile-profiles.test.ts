import { describe, expect, it } from "vitest";
import { createProvider } from "../src/models.ts";
import { KIMI_CODE_RETRY_PROFILE, SENPI_DEFAULT_RETRY_PROFILE } from "../src/utils/retry-profile/profiles.ts";

describe("shipped retry profiles", () => {
	it("pins the shipped profiles", () => {
		expect(SENPI_DEFAULT_RETRY_PROFILE.id).toBe("senpi-default");
		expect(KIMI_CODE_RETRY_PROFILE.id).toBe("kimi-code");
		expect(SENPI_DEFAULT_RETRY_PROFILE.providerRequest.maxRetries).toBe(0);
		expect(SENPI_DEFAULT_RETRY_PROFILE.turn.maxRetries).toBe(3);
		expect(KIMI_CODE_RETRY_PROFILE.providerRequest.enabled).toBe(false);
		expect(KIMI_CODE_RETRY_PROFILE.turn.maxRetries).toBe(9);
	});

	it("forwards retryPolicy through provider creation", () => {
		const api = { stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); } };
		const input = { id: "test", auth: { type: "apiKey", check: async () => ({ type: "not_configured" as const }) }, models: [], api };
		const without = createProvider(input);
		const withProfile = createProvider({ ...input, retryPolicy: KIMI_CODE_RETRY_PROFILE });
		expect(without.retryPolicy).toBeUndefined();
		expect(withProfile.retryPolicy).toBe(KIMI_CODE_RETRY_PROFILE);
	});
});
