import type { OAuthAuth } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { listAccounts, SENTINEL_OAUTH_FIELDS } from "../src/core/extensions/builtin/claude-agent-sdk/accounts.ts";
import { createOAuthConfig } from "../src/core/extensions/builtin/claude-agent-sdk/oauth-login.ts";

function fakeFlow(credential: { access: string; refresh: string; expires: number }): OAuthAuth {
	return {
		name: "fake",
		async login() {
			return { type: "oauth", ...credential };
		},
		async refresh(current) {
			return current;
		},
		async toAuth(current) {
			return { apiKey: current.access };
		},
	};
}

const fresh = { access: "a1", refresh: "r1", expires: Date.now() + 60_000 };

describe("claude-agent-sdk oauth login config", () => {
	it("first login creates the default slot and imports the anthropic credential", async () => {
		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			readAnthropicCredential: async () => ({ access: "ia", refresh: "ir", expires: 1 }),
			loginFlow: fakeFlow(fresh),
		});
		const credential = await config.login({});
		const names = listAccounts(credential as never).map((slot) => slot.name);
		expect(names).toEqual(["default", "imported-anthropic"]);
		expect((credential as never as { type: string }).type).toBe("oauth");
	});

	it("second login adds a prompted account name without dropping slots", async () => {
		const existing = await createOAuthConfig({
			readCurrent: async () => undefined,
			loginFlow: fakeFlow(fresh),
		}).login({});
		const config = createOAuthConfig({
			readCurrent: async () => existing as never,
			loginFlow: fakeFlow({ access: "a2", refresh: "r2", expires: Date.now() + 60_000 }),
		});
		const credential = await config.login({ onPrompt: async () => "work" });
		const slots = listAccounts(credential as never);
		expect(slots.map((slot) => slot.name)).toEqual(["default", "work"]);
		expect(slots[1]?.access).toBe("a2");
	});

	it("keeps sentinel top-level fields and sentinel getApiKey", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, loginFlow: fakeFlow(fresh) });
		const credential = await config.login({});
		expect((credential as { access: string }).access).toBe(SENTINEL_OAUTH_FIELDS.access);
		expect(config.getApiKey(credential)).toBe(SENTINEL_OAUTH_FIELDS.access);
	});

	it("refreshToken is a preserving no-op", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, loginFlow: fakeFlow(fresh) });
		const credential = await config.login({});
		expect(await config.refreshToken(credential)).toBe(credential);
	});
});
