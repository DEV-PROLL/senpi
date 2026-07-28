import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const oauthConfig = {
	name: "Test OAuth (Extension)",
	async login() {
		return { type: "oauth" as const, access: "a", refresh: "r", expires: Date.now() + 60_000 };
	},
	async refreshToken(credentials: { access: string; refresh: string; expires: number }) {
		return credentials;
	},
	getApiKey(credentials: { access: string }) {
		return credentials.access;
	},
};

const modelEntry = {
	id: "test-model",
	name: "test-model",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

describe("ModelRuntime extension oauth bridge", () => {
	it("syncs extension-registered oauth into AuthStorage and removes it on unregister", async () => {
		const storage = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({
			credentials: storage,
			modelsPath: null,
			allowModelNetwork: false,
		});
		await runtime.registerProvider("test-oauth-provider", {
			baseUrl: "http://127.0.0.1:1",
			api: "openai-completions",
			apiKey: "$TEST_OAUTH_BRIDGE_UNUSED",
			oauth: oauthConfig,
			models: [modelEntry],
		});
		expect(storage.getOAuthProviders()).toContainEqual({
			id: "test-oauth-provider",
			name: "Test OAuth (Extension)",
		});
		runtime.unregisterProvider("test-oauth-provider");
		expect(storage.getOAuthProviders().map((p) => p.id)).not.toContain("test-oauth-provider");
	});

	it("does not register an oauth entry for api-key-only providers", async () => {
		const storage = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({
			credentials: storage,
			modelsPath: null,
			allowModelNetwork: false,
		});
		await runtime.registerProvider("test-key-provider", {
			baseUrl: "http://127.0.0.1:1",
			api: "openai-completions",
			apiKey: "$TEST_KEY_BRIDGE",
			models: [modelEntry],
		});
		expect(storage.getOAuthProviders().map((p) => p.id)).not.toContain("test-key-provider");
	});
});
