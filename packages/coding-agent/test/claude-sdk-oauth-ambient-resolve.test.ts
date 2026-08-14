import {
	type AuthContext,
	type Credential,
	type CredentialStore,
	createModels,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProviderAuth } from "../../ai/src/auth/resolve.ts";
import {
	addAccount,
	emptyCredential,
	SENTINEL_OAUTH_FIELDS,
} from "../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/auth-lane.ts";
import {
	CLAUDE_SDK_OAUTH_PROVIDER_ID,
	registerClaudeSdkOauthExtension,
} from "../src/core/extensions/builtin/claude-sdk-oauth/index.ts";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
} from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider, type ProviderConfigInput } from "../src/core/provider-composer.ts";
import { generateSessionTitle } from "../src/core/session-title-generator.ts";

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

function composedProvider(readAmbientAuthStatus: () => Promise<boolean>, overrides: Partial<ProviderConfigInput> = {}) {
	const modelConfig = { getProvider: () => undefined } as unknown as ModelConfig;
	return composeModelProvider(CLAUDE_SDK_OAUTH_PROVIDER_ID, undefined, modelConfig, {
		...registeredProviderConfig(readAmbientAuthStatus),
		...overrides,
	});
}

function credentialStore(stored?: Credential): CredentialStore {
	return {
		read: async (): Promise<Credential | undefined> => stored,
		list: async () => [],
		modify: async (_providerId, fn) => (stored = (await fn(stored)) ?? stored),
		delete: async () => {
			stored = undefined;
		},
	};
}

function authContext(environment: Record<string, string> = {}): AuthContext {
	return {
		env: async (name) => environment[name],
		fileExists: async () => false,
	};
}

function queryCapturing(captured: Options[]): SdkQuery {
	return ({ options }) => {
		if (!options) throw new Error("SDK query options are required");
		captured.push(options);
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield {
					type: "result",
					subtype: "success",
					result: "<title>Auxiliary Auth Works</title>",
				} as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
	};
}

afterEach(() => {
	resetSdkBoundary();
	resetAuthLaneBoundary();
});

describe("claude-sdk-oauth ambient auth resolution", () => {
	it("resolves request auth from an authenticated ambient Claude CLI with nothing stored", async () => {
		const provider = composedProvider(async () => true);

		const resolved = await resolveProviderAuth(provider, credentialStore(), authContext());

		expect(resolved?.auth.apiKey).toBe(SENTINEL_OAUTH_FIELDS.access);
	});

	it("resolves request auth from CLAUDE_CODE_OAUTH_TOKEN with nothing stored", async () => {
		const provider = composedProvider(async () => false);

		const resolved = await resolveProviderAuth(
			provider,
			credentialStore(),
			authContext({ CLAUDE_CODE_OAUTH_TOKEN: "env-token" }),
		);

		expect(resolved?.auth.apiKey).toBe(SENTINEL_OAUTH_FIELDS.access);
		expect(resolved?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "env-token" });
	});

	it("reports not configured when ambient auth is logged out and nothing is stored", async () => {
		const provider = composedProvider(async () => false);

		expect(await resolveProviderAuth(provider, credentialStore(), authContext())).toBeUndefined();
	});

	it("rejects a persisted empty OAuth envelope when ambient auth is logged out", async () => {
		const provider = composedProvider(async () => false);

		expect(await resolveProviderAuth(provider, credentialStore(emptyCredential()), authContext())).toBeUndefined();
	});

	it("composes configured headers and authHeader identically for ambient and stored OAuth", async () => {
		const provider = composedProvider(async () => true, {
			headers: { "User-Agent": "must-survive" },
			authHeader: true,
		});
		const stored = addAccount(emptyCredential(), {
			name: "stored",
			access: "stored-token",
			refresh: "stored-refresh",
			expires: Date.now() + 60 * 60_000,
			source: "login",
		});

		const ambient = await resolveProviderAuth(provider, credentialStore(), authContext());
		const managed = await resolveProviderAuth(provider, credentialStore(stored), authContext());

		expect(ambient?.auth).toEqual(managed?.auth);
		expect(ambient?.auth.headers).toEqual({
			"User-Agent": "must-survive",
			Authorization: `Bearer ${SENTINEL_OAUTH_FIELDS.access}`,
		});
	});

	it("keeps request auth idempotent through title generation and forwards request env to the SDK", async () => {
		const provider = composedProvider(async () => false);
		const credentials = new InMemoryCredentialStore();
		const hostEnvironment = { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "host-token" };
		const requestEnvironment = { CLAUDE_CODE_OAUTH_TOKEN: "request-token" };
		const models = createModels({ credentials, authContext: authContext(hostEnvironment) });
		models.setProvider(provider);
		const captured: Options[] = [];
		overrideAuthLaneBoundary({ createStore: () => credentials, env: () => hostEnvironment });
		overrideSdkBoundary({ query: queryCapturing(captured) });

		const first = await models.getAuth(provider.id, { env: requestEnvironment });
		if (!first?.auth.apiKey) throw new Error("Expected initial ambient auth");
		const replay = await models.getAuth(provider.id, { apiKey: first.auth.apiKey, env: first.env });
		const model = provider.getModels()[0];
		if (!model) throw new Error("Expected registered Claude model");
		const title = await generateSessionTitle({
			firstPrompt: "Fix the ambient authentication boundary",
			model,
			auth: { apiKey: first.auth.apiKey, env: first.env },
			sessionId: "ambient-title-test",
			streamFn: (titleModel, titleContext, titleOptions) =>
				models.streamSimple(titleModel, titleContext, titleOptions),
		});

		expect(replay?.auth.apiKey).toBe(first.auth.apiKey);
		expect(replay?.env).toEqual(requestEnvironment);
		expect(title).toBe("Auxiliary Auth Works");
		expect(captured).toHaveLength(1);
		expect(captured[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("request-token");
		expect(captured[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).not.toBe("host-token");
	});
});
