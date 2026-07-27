import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type Context,
	type CredentialStore,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { subscribeProviderAccountEvents } from "../src/core/extensions/builtin/claude-agent-sdk/account-events.ts";
import {
	type AccountSlot,
	addAccount,
	type ClaudeAgentSdkCredential,
	emptyCredential,
} from "../src/core/extensions/builtin/claude-agent-sdk/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../src/core/extensions/builtin/claude-agent-sdk/auth-lane.ts";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
	type SdkQueryHandle,
} from "../src/core/extensions/builtin/claude-agent-sdk/sdk-boundary.ts";
import { streamClaudeAgentSdk } from "../src/core/extensions/builtin/claude-agent-sdk/stream.ts";

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-agent-sdk",
	provider: "claude-agent-sdk",
	baseUrl: "claude-agent-sdk",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const context: Context = { messages: [] };
const providerId = "claude-agent-sdk";
const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "senpi-claude-agent-sdk-auth-lane-"));
	temporaryDirectories.push(directory);
	return directory;
}

function queryCapturing(captured: Options[]): SdkQuery {
	return (input) => {
		if (!input.options) throw new Error("SDK query options are required");
		captured.push(input.options);
		const handle: SdkQueryHandle = {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield {
					type: "result",
					subtype: "success",
					result: "ok",
				} as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
		return handle;
	};
}

async function storeWith(...credentials: AccountSlot[]): Promise<CredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(providerId, async () =>
		credentials.reduce<ClaudeAgentSdkCredential>(
			(credential, slot) => addAccount(credential, slot),
			emptyCredential(),
		),
	);
	return store;
}

function slot(name: string, access: string, expires = Date.now() + 60 * 60_000) {
	return { name, access, refresh: `${name}-refresh`, expires, source: "login" as const };
}

function managedEnvironment(): NodeJS.ProcessEnv {
	return {
		PATH: "/usr/bin",
		ANTHROPIC_API_KEY: "parent-api-key",
		ANTHROPIC_AUTH_TOKEN: "parent-auth-token",
		ANTHROPIC_BASE_URL: "https://gateway.invalid",
		CLAUDE_CODE_OAUTH_TOKEN: "parent-oauth-token",
		CLAUDE_CODE_USE_BEDROCK: "1",
		CLAUDE_CODE_USE_VERTEX: "1",
	};
}

function configureAuth(store: CredentialStore, environment: NodeJS.ProcessEnv, agentDir = temporaryDirectory()): void {
	process.env.SENPI_CODING_AGENT_DIR = agentDir;
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => environment,
		getAgentDir: () => agentDir,
	});
}

afterEach(() => {
	resetSdkBoundary();
	resetAuthLaneBoundary();
	if (originalAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
	else process.env.SENPI_CODING_AGENT_DIR = originalAgentDir;
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Claude Agent SDK auth lanes", () => {
	it("injects an OAuth slot and strips higher-precedence API-key sources", async () => {
		const store = await storeWith(slot("default", "slot-access"));
		const captured: Options[] = [];
		configureAuth(store, managedEnvironment());
		overrideSdkBoundary({ query: queryCapturing(captured) });

		await streamClaudeAgentSdk(model, context).result();

		expect(captured).toHaveLength(1);
		expect(captured[0]?.env).toMatchObject({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "slot-access" });
		expect(captured[0]?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
		expect(captured[0]?.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
		expect(captured[0]?.env).not.toHaveProperty("ANTHROPIC_BASE_URL");
		expect(captured[0]?.env).not.toHaveProperty("CLAUDE_CODE_USE_BEDROCK");
		expect(captured[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("slot-access");
		expect(captured[0]?.env).not.toHaveProperty("CLAUDE_CODE_USE_VERTEX");
	});

	it("leaves the subprocess environment entirely untouched in ambient mode", async () => {
		const captured: Options[] = [];
		const { CLAUDE_CODE_OAUTH_TOKEN: _oauthToken, ...ambientEnvironment } = managedEnvironment();
		configureAuth(new InMemoryCredentialStore(), ambientEnvironment);
		overrideSdkBoundary({ query: queryCapturing(captured) });

		await streamClaudeAgentSdk(model, context).result();

		expect(captured).toHaveLength(1);
		expect(captured[0]?.env).toBeUndefined();
	});

	it("refreshes an expired slot before spawning the SDK query", async () => {
		const store = await storeWith(slot("default", "stale-access", Date.now() - 1));
		const captured: Options[] = [];
		let refreshes = 0;
		configureAuth(store, managedEnvironment());
		overrideAuthLaneBoundary({
			refresher: async () => {
				refreshes++;
				return { access: "fresh-access", refresh: "fresh-refresh", expires: Date.now() + 60 * 60_000 };
			},
		});
		overrideSdkBoundary({ query: queryCapturing(captured) });

		await streamClaudeAgentSdk(model, context).result();

		expect(refreshes).toBe(1);
		expect(captured[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("fresh-access");
		const credential = (await store.read(providerId)) as ClaudeAgentSdkCredential;
		expect(credential.accounts?.[0]).toMatchObject({ access: "fresh-access", refresh: "fresh-refresh" });
	});

	it("writes a private Claude config directory with the CLI OAuth schema", async () => {
		const agentDir = temporaryDirectory();
		const store = await storeWith(slot("work", "config-access", Date.now() + 60 * 60_000));
		const captured: Options[] = [];
		configureAuth(store, managedEnvironment(), agentDir);
		overrideSdkBoundary({ query: queryCapturing(captured) });

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ claudeAgentSdkProvider: { tokenInjection: "config-dir" } }),
		);

		await streamClaudeAgentSdk(model, context).result();

		const configDir = join(agentDir, "claude-agent-sdk-accounts", "work");
		expect(captured[0]?.env?.CLAUDE_CONFIG_DIR).toBe(configDir);
		expect(captured[0]?.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
		expect(statSync(configDir).mode & 0o777).toBe(0o700);
		expect(JSON.parse(readFileSync(join(configDir, ".credentials.json"), "utf8"))).toEqual({
			claudeAiOauth: {
				accessToken: "config-access",
				refreshToken: "work-refresh",
				expiresAt: expect.any(Number),
				scopes: expect.arrayContaining(["user:inference", "user:sessions:claude_code"]),
			},
		});
	});

	it("fails over from an invalid stale slot before the first delta without surfacing an OAuth error", async () => {
		const store = await storeWith(
			slot("A", "expired-access", Date.now() - 1),
			slot("B", "valid-access", Date.now() + 60 * 60_000),
		);
		const captured: Options[] = [];
		configureAuth(store, managedEnvironment());
		await store.modify(providerId, async (current) =>
			current?.type === "oauth" ? { ...current, pinned: "A" } : current,
		);
		overrideAuthLaneBoundary({ refresher: async () => Promise.reject(new Error("invalid refresh")) });
		overrideSdkBoundary({ query: queryCapturing(captured) });
		const accountEvents: Array<Record<string, unknown>> = [];
		const unsubscribe = subscribeProviderAccountEvents((event) => accountEvents.push(event));

		try {
			const result = await streamClaudeAgentSdk(model, context).result();

			expect(result.content).toEqual([{ type: "text", text: "ok" }]);
			expect(captured.map((options) => options.env?.CLAUDE_CODE_OAUTH_TOKEN)).toEqual(["valid-access"]);
			const credential = (await store.read(providerId)) as ClaudeAgentSdkCredential;
			expect(credential.accounts?.find((account) => account.name === "A")).toMatchObject({
				blockReason: "auth_error",
			});
			expect(accountEvents).toEqual([
				{ type: "accounts_changed", provider: providerId },
				{ type: "failover", provider: providerId, from: "A", to: "B", reason: "auth_error" },
			]);
		} finally {
			unsubscribe();
		}
	});
});
