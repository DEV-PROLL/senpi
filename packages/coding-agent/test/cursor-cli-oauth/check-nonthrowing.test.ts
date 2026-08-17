import type { AuthContext, Model, OAuthAuth, Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type CursorCliOauthCredential,
	emptyCredential,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import { CursorAgentNotInstalledError } from "../../src/core/extensions/builtin/cursor-cli-oauth/executable.ts";
import {
	type CursorCliOauthConfig,
	type CursorCliOauthConfigDeps,
	createCursorCliOauthConfig,
	resolveCursorCliOauthLane,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/oauth-login.ts";

/**
 * Regression: the OAuth config `check` must never throw.
 *
 * `ModelsImpl.getAvailable` (packages/ai/src/models.ts:544-548) runs
 * `Promise.all` over `checkProviderAuth` for EVERY provider, and
 * `checkProviderAuth` converts a throwing `oauth.check` into a rejecting
 * `ModelsError("auth", ...)`. One throwing check therefore rejects all model
 * listing. The extension registers this config unchanged
 * (cursor-cli-oauth/index.ts:55) and the composer forwards `check`
 * verbatim into pi-ai's `OAuthAuth` (provider-composer.ts `adaptOAuth`), so
 * the tolerance contract of `OAuthAuth.check` ("undefined when not
 * configured") must hold here too — exactly as claude-sdk-oauth's check does.
 */

function authContext(): AuthContext {
	return {
		env: async () => undefined,
		fileExists: async () => false,
	};
}

function account(name = "default", access = "access-token") {
	return {
		name,
		access,
		refresh: "refresh-token",
		expires: Date.now() + 60_000,
		source: "login" as const,
	};
}

function credential(accounts: CursorCliOauthAccount[] = [account()]): CursorCliOauthCredential {
	return { ...emptyCredential(), accounts };
}

type CursorCliOauthAccount = ReturnType<typeof account>;

function dependencies(overrides: Partial<CursorCliOauthConfigDeps> = {}) {
	return {
		readCurrent: async () => credential(),
		readSettings: () => ({ enabled: true, executablePath: undefined }),
		resolveExecutable: () => "/usr/local/bin/cursor-agent",
		...overrides,
	};
}

function configuredCheck(deps: CursorCliOauthConfigDeps) {
	return createCursorCliOauthConfig(deps).check({ ctx: authContext() });
}

describe("cursor-cli-oauth check stays non-throwing", () => {
	it("resolves undefined when disabled by settings, even with a stored account", async () => {
		await expect(
			configuredCheck(
				dependencies({ readSettings: () => ({ enabled: false, executablePath: undefined }) }),
			),
		).resolves.toBeUndefined();
	});

	it("resolves undefined when the cursor-agent executable is missing", async () => {
		await expect(
			configuredCheck(
				dependencies({
					resolveExecutable: () => {
						throw new CursorAgentNotInstalledError();
					},
				}),
			),
		).resolves.toBeUndefined();
	});

	it("resolves undefined with no accounts, an empty store, or a non-OAuth credential", async () => {
		await expect(
			configuredCheck(dependencies({ readCurrent: async () => emptyCredential() })),
		).resolves.toBeUndefined();

		await expect(
			configuredCheck(dependencies({ readCurrent: async () => undefined })),
		).resolves.toBeUndefined();

		await expect(
			configuredCheck(
				dependencies({ readCurrent: async () => ({ type: "api_key", key: "not-oauth" }) }),
			),
		).resolves.toBeUndefined();
	});

	it("still reports the configured AUTH_CHECK-equivalent for usable accounts", async () => {
		await expect(
			configuredCheck(dependencies({ readCurrent: async () => credential([account(), account("work")]) })),
		).resolves.toEqual({ type: "oauth", source: "configured (file-store, 2 accounts)" });
	});

	it("keeps turn-time lane resolution throwing for a disabled lane", async () => {
		await expect(
			resolveCursorCliOauthLane(
				dependencies({ readSettings: () => ({ enabled: false, executablePath: undefined }) }),
			),
		).rejects.toThrow("disabled by settings");

		await expect(
			resolveCursorCliOauthLane(dependencies({ readCurrent: async () => emptyCredential() })),
		).rejects.toThrow("no accounts: run /login cursor-cli-oauth");
	});
});

/** Mirrors provider-composer `adaptOAuth`'s verbatim `check` pass-through. */
function asOAuthAuth(config: CursorCliOauthConfig): OAuthAuth {
	return {
		name: config.name,
		isSubscription: config.isSubscription,
		login: async () => {
			throw new Error("login is not exercised by getAvailable");
		},
		refresh: async (stored) => stored,
		toAuth: async () => ({ apiKey: "unused" }),
		check: config.check,
	};
}

function model(provider: string, id: string): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_000,
		maxTokens: 1_000,
	};
}

function oauthProvider(config: CursorCliOauthConfig): Provider {
	return {
		id: "cursor-cli-oauth",
		name: config.name,
		baseUrl: "https://example.test",
		auth: { oauth: asOAuthAuth(config) },
		getModels: () => [model("cursor-cli-oauth", "cursor-model")],
	};
}

function healthyProvider(): Provider {
	return {
		id: "healthy-oauth",
		name: "Healthy OAuth",
		baseUrl: "https://example.test",
		auth: {
			oauth: {
				name: "Healthy OAuth",
				login: async () => {
					throw new Error("not exercised");
				},
				refresh: async (stored) => stored,
				toAuth: async () => ({ apiKey: "unused" }),
				check: async () => ({ type: "oauth", source: "healthy" }),
			},
		},
		getModels: () => [model("healthy-oauth", "healthy-model")],
	};
}

describe("ModelsImpl.getAvailable integration", () => {
	it("a disabled or uninstalled cursor-cli-oauth never rejects model listing", async () => {
		const disabled = createModels();
		disabled.setProvider(healthyProvider());
		disabled.setProvider(
			oauthProvider(
				createCursorCliOauthConfig(
					dependencies({ readSettings: () => ({ enabled: false, executablePath: undefined }) }),
				),
			),
		);
		const disabledModels = await disabled.getAvailable();
		expect(disabledModels.map((entry) => entry.id)).toEqual(["healthy-model"]);

		const uninstalled = createModels();
		uninstalled.setProvider(healthyProvider());
		uninstalled.setProvider(
			oauthConfigWithMissingExecutable(),
		);
		const uninstalledModels = await uninstalled.getAvailable();
		expect(uninstalledModels.map((entry) => entry.id)).toEqual(["healthy-model"]);
	});

	it("lists cursor-cli-oauth models once the check reports configured", async () => {
		const models = createModels();
		models.setProvider(healthyProvider());
		models.setProvider(oauthProvider(createCursorCliOauthConfig(dependencies())));

		const available = await models.getAvailable();
		expect(available.map((entry) => entry.id).sort()).toEqual(["cursor-model", "healthy-model"]);
	});
});

function oauthConfigWithMissingExecutable(): Provider {
	return oauthProvider(
		createCursorCliOauthConfig(
			dependencies({
				resolveExecutable: () => {
					throw new CursorAgentNotInstalledError();
				},
			}),
		),
	);
}
