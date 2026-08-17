import type { AuthContext, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { emptyCredential, type CursorCliOauthCredential } from "../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import {
	createCursorCliOauthConfig,
	importLocalCursorCredential,
	resolveCursorCliOauthLane,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/oauth-login.ts";

const PROVIDER_ID = "cursor-cli-oauth";

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

function credential(accounts = [account()]): CursorCliOauthCredential {
	return { ...emptyCredential(), accounts };
}

function oauthFlow(overrides: Partial<OAuthAuth> = {}): OAuthAuth {
	return {
		name: "Cursor",
		login: async (_interaction: ProviderAuthInteraction): Promise<OAuthCredential> => ({
			type: "oauth",
			access: "logged-in-access",
			refresh: "logged-in-refresh",
			expires: Date.now() + 120_000,
		}),
		refresh: async (stored) => stored,
		toAuth: async (stored) => ({ apiKey: stored.access }),
		...overrides,
	};
}

function dependencies(current: () => Promise<CursorCliOauthCredential | undefined>) {
	return {
		readCurrent: current,
		readSettings: () => ({ enabled: true, executablePath: undefined }),
		resolveExecutable: () => "/usr/local/bin/cursor-agent",
		loadOAuth: async () => oauthFlow(),
	};
}

describe("cursor-cli-oauth login and availability", () => {
	it("uses one fresh-state predicate and always resolves the file-store lane", async () => {
		let stored = credential([account("default", "old-token")]);
		const deps = dependencies(async () => stored);
		const config = createCursorCliOauthConfig(deps);

		await expect(config.check({ ctx: authContext(), credential: stored })).resolves.toEqual({
			type: "oauth",
			source: "configured (file-store, 1 accounts)",
		});

		stored = credential([account("default", "fresh-token")]);
		const resolution = await resolveCursorCliOauthLane(deps);
		expect(resolution.lane).toBe("file-store");
		expect(resolution.account.access).toBe("fresh-token");
	});

	it("contains no alternate lane value in the implementation", async () => {
		const source = await readFile(
			new URL("../../src/core/extensions/builtin/cursor-cli-oauth/oauth-login.ts", import.meta.url),
			"utf8",
		);
		expect(source).not.toContain(`am${"bient"}`);
	});

	it("reports configured only for non-empty OAuth account slots", async () => {
		const config = createCursorCliOauthConfig(dependencies(async () => credential([account(), account("other")])));
		await expect(config.check({ ctx: authContext() })).resolves.toEqual({
			type: "oauth",
			source: "configured (file-store, 2 accounts)",
		});
	});

	it("reports disabled by settings", async () => {
		const deps = {
			...dependencies(async () => credential()),
			readSettings: () => ({ enabled: false, executablePath: undefined }),
		};
		const config = createCursorCliOauthConfig(deps);
		await expect(config.check({ ctx: authContext() })).rejects.toThrow("disabled by settings");
	});

	it("reports cursor-agent installation guidance", async () => {
		const deps = {
			...dependencies(async () => credential()),
			resolveExecutable: () => {
				throw new Error(
					"Cursor CLI is not installed. Install it with `curl https://cursor.com/install -fsS | bash`, then ensure ~/.local/bin is on your PATH.",
				);
			},
		};
		const config = createCursorCliOauthConfig(deps);
		await expect(config.check({ ctx: authContext() })).rejects.toThrow(
			"cursor-agent not installed: Install it with `curl https://cursor.com/install -fsS | bash`, then ensure ~/.local/bin is on your PATH.",
		);
	});

	it("reports no accounts for an empty or malformed provider credential", async () => {
		const emptyConfig = createCursorCliOauthConfig(dependencies(async () => emptyCredential()));
		await expect(emptyConfig.check({ ctx: authContext() })).rejects.toThrow(
			"no accounts: run /login cursor-cli-oauth",
		);

		const malformed = { type: "api_key", key: "not-oauth" };
		const malformedConfig = createCursorCliOauthConfig({
			...dependencies(async () => undefined),
			readCurrent: async () => malformed,
		});
		await expect(malformedConfig.check({ ctx: authContext() })).rejects.toThrow(
			"no accounts: run /login cursor-cli-oauth",
		);
	});

	it("does not count an account with an empty access token as configured", async () => {
		const config = createCursorCliOauthConfig(dependencies(async () => credential([account("default", "")])));
		await expect(config.check({ ctx: authContext() })).rejects.toThrow(
			"no accounts: run /login cursor-cli-oauth",
		);
	});

	it("check never reads a real Cursor credential source", async () => {
		const readCursorFile = vi.fn(async () => ({ access: "file", refresh: "file-refresh" }));
		const readCursorKeychain = vi.fn(async () => ({ access: "keychain", refresh: "keychain-refresh" }));
		const config = createCursorCliOauthConfig({
			...dependencies(async () => credential()),
			readCursorFile,
			readCursorKeychain,
		});

		await config.check({ ctx: authContext() });
		expect(readCursorFile).not.toHaveBeenCalled();
		expect(readCursorKeychain).not.toHaveBeenCalled();
	});

	it("names the first login default and prompts when a slot already exists", async () => {
		const login = vi.fn(oauthFlow().login);
		const first = createCursorCliOauthConfig({
			...dependencies(async () => undefined),
			loadOAuth: async () => oauthFlow({ login }),
		});
		const prompt = vi.fn(async () => "work");
		const callbacks = {
			onAuth: vi.fn(),
			onDeviceCode: vi.fn(),
			onPrompt: prompt,
			onSelect: vi.fn(async () => undefined),
		};

		const firstCredential = await first.login(callbacks);
		expect((firstCredential.accounts as Array<{ name: string }>)[0]?.name).toBe("default");
		expect(prompt).not.toHaveBeenCalled();

		const second = createCursorCliOauthConfig({
			...dependencies(async () => firstCredential as CursorCliOauthCredential),
			loadOAuth: async () => oauthFlow({ login }),
		});
		const secondCredential = await second.login(callbacks);
		expect((secondCredential.accounts as Array<{ name: string }>).map((slot) => slot.name)).toEqual([
			"default",
			"work",
		]);
		expect(prompt).toHaveBeenCalledOnce();
		expect(login).toHaveBeenCalledTimes(2);
	});

	it("delegates expired slot refresh to the Cursor OAuth loader", async () => {
		const refresh = vi.fn(async (_stored: OAuthCredential, _signal: AbortSignal): Promise<OAuthCredential> => ({
			type: "oauth",
			access: "refreshed-access",
			refresh: "rotated-refresh",
			expires: Date.now() + 120_000,
		}));
		const config = createCursorCliOauthConfig({
			...dependencies(async () => undefined),
			loadOAuth: async () => oauthFlow({ refresh }),
		});
		const expired = credential([{ ...account(), expires: 0 }]);
		const refreshed = (await config.refreshToken(expired, new AbortController().signal)) as CursorCliOauthCredential;

		expect(refresh).toHaveBeenCalledOnce();
		expect(refreshed.accounts?.[0]).toMatchObject({
			access: "refreshed-access",
			refresh: "rotated-refresh",
		});
	});

	it("explicit import copies a credential into a named slot with import source", async () => {
		const readCursorFile = vi.fn(async () => ({
			access: "copied-access",
			refresh: "copied-refresh",
			expires: 123_456,
		}));
		const imported = await importLocalCursorCredential(emptyCredential(), {
			platform: "linux",
			readCursorFile,
			readCursorKeychain: vi.fn(async () => undefined),
		});

		expect(imported.accounts).toEqual([
			{
				name: "default",
				access: "copied-access",
				refresh: "copied-refresh",
				expires: 123_456,
				source: "import",
			},
		]);
		expect(readCursorFile).toHaveBeenCalledOnce();
	});

	it("uses the provider sentinel as its API key", () => {
		const config = createCursorCliOauthConfig(dependencies(async () => credential()));
		expect(config.getApiKey(credential())).toBe(PROVIDER_ID + "-managed");
	});
});
