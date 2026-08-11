import type { AuthContext, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveProviderAuth } from "../../ai/src/auth/resolve.ts";
import { SENTINEL_OAUTH_FIELDS } from "../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import {
	CLAUDE_SDK_OAUTH_PROVIDER_ID,
	registerClaudeSdkOauthExtension,
} from "../src/core/extensions/builtin/claude-sdk-oauth/index.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider, type ProviderConfigInput } from "../src/core/provider-composer.ts";

/** Captures the provider config the extension registers, without a real runtime. */
function registeredProviderConfig(readAmbientAuthStatus: () => Promise<boolean>): ProviderConfigInput {
	let captured: ProviderConfigInput | undefined;
	const pi = new Proxy(
		{},
		{
			get:
				(_target, property) =>
				(...args: unknown[]) => {
					if (property === "registerProvider") captured = args[1] as ProviderConfigInput;
				},
		},
	) as unknown as ExtensionAPI;
	registerClaudeSdkOauthExtension(pi, { readAmbientAuthStatus });
	if (!captured) throw new Error("extension did not register a provider");
	return captured;
}

function composedProvider(readAmbientAuthStatus: () => Promise<boolean>) {
	const modelConfig = { getProvider: () => undefined } as unknown as ModelConfig;
	return composeModelProvider(
		CLAUDE_SDK_OAUTH_PROVIDER_ID,
		undefined,
		modelConfig,
		registeredProviderConfig(readAmbientAuthStatus),
	);
}

/** An auth.json with nothing stored for any provider — the state after a fresh install. */
function emptyCredentialStore(): CredentialStore {
	return {
		read: async (): Promise<Credential | undefined> => undefined,
		list: async () => [],
		modify: async () => undefined,
		delete: async () => {},
	};
}

function authContext(environment: Record<string, string> = {}): AuthContext {
	return {
		env: async (name) => environment[name],
		fileExists: async () => false,
	};
}

describe("claude-sdk-oauth ambient auth resolution", () => {
	it("resolves request auth from an authenticated ambient Claude CLI with nothing stored", async () => {
		const provider = composedProvider(async () => true);

		const resolved = await resolveProviderAuth(provider, emptyCredentialStore(), authContext());

		expect(resolved?.auth.apiKey).toBe(SENTINEL_OAUTH_FIELDS.access);
	});

	it("resolves request auth from CLAUDE_CODE_OAUTH_TOKEN with nothing stored", async () => {
		const provider = composedProvider(async () => false);

		const resolved = await resolveProviderAuth(
			provider,
			emptyCredentialStore(),
			authContext({ CLAUDE_CODE_OAUTH_TOKEN: "env-token" }),
		);

		expect(resolved?.auth.apiKey).toBe(SENTINEL_OAUTH_FIELDS.access);
	});

	it("reports not configured when ambient auth is logged out and nothing is stored", async () => {
		const provider = composedProvider(async () => false);

		expect(await resolveProviderAuth(provider, emptyCredentialStore(), authContext())).toBeUndefined();
	});
});
