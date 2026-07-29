import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext, Model, Provider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider, configuredRequestAuthStatus } from "../src/core/provider-composer.ts";

let tempDir: string | undefined;
let modelConfig: ModelConfig;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "senpi-composer-headers-auth-"));
	const modelsPath = join(tempDir, "models.json");
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				"headers-only": {
					baseUrl: "https://example.invalid/v1",
					api: "openai-completions",
					headers: { "x-api-key": "header-key" },
					models: [{ id: "headers-model" }],
				},
				unconfigured: {
					baseUrl: "https://example.invalid/v1",
					api: "openai-completions",
					models: [{ id: "unconfigured-model" }],
				},
				"api-key": {
					baseUrl: "https://example.invalid/v1",
					api: "openai-completions",
					apiKey: "configured-api-key",
					models: [{ id: "api-key-model" }],
				},
				"auth-header": {
					authHeader: true,
				},
			},
		}),
	);
	modelConfig = ModelConfig.loadSync(modelsPath);
});

afterEach(() => {
	if (tempDir !== undefined) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function requestAuthStatus(providerId: string) {
	return configuredRequestAuthStatus(modelConfig.getProvider(providerId), undefined) ?? { configured: false };
}

function authHeaderBaseProvider(): Provider {
	const model: Model<"openai-completions"> = {
		id: "auth-header-model",
		name: "auth-header-model",
		api: "openai-completions",
		provider: "auth-header",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
	return {
		id: "auth-header",
		name: "Auth header",
		auth: {
			apiKey: {
				name: "Inherited auth",
				resolve: async () => ({ auth: {} }),
			},
		},
		getModels: () => [model],
		stream: () => {
			throw new Error("not used");
		},
		streamSimple: () => {
			throw new Error("not used");
		},
	};
}

const emptyAuthContext: AuthContext = {
	env: async () => undefined,
	fileExists: async () => false,
};

describe("configured request auth status", () => {
	it("reports a headers-only provider as configured", () => {
		expect(requestAuthStatus("headers-only")).toEqual({ configured: true, source: "models_json_key" });
	});

	it("keeps providers without an API key or headers unconfigured", () => {
		expect(requestAuthStatus("unconfigured")).toEqual({ configured: false });
	});

	it("preserves the API-key status source", () => {
		expect(requestAuthStatus("api-key")).toEqual({ configured: true, source: "models_json_key" });
	});

	it("preserves the authHeader missing-key error", async () => {
		const provider = composeModelProvider("auth-header", authHeaderBaseProvider(), modelConfig, undefined);
		const apiKey = provider.auth.apiKey;
		expect(apiKey).toBeDefined();
		await expect(apiKey!.resolve({ ctx: emptyAuthContext })).rejects.toThrow(
			"authHeader requires a resolved API key",
		);
	});
});
