import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { model } from "./recommended-models-harness.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

async function createBoundSession(models: Model<Api>[], factory: (pi: ExtensionAPI) => void) {
	const provider = models[0].provider;
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(provider, {
		baseUrl: models[0].baseUrl,
		api: models[0].api,
		models: models.map((entry) => ({
			id: entry.id,
			name: entry.name,
			api: entry.api,
			reasoning: entry.reasoning,
			input: entry.input,
			cost: entry.cost,
			contextWindow: entry.contextWindow,
			maxTokens: entry.maxTokens,
		})),
	});
	const settingsManager = SettingsManager.inMemory({ defaultProvider: provider, defaultModel: models[0].id });
	const extensionsResult = await createTestExtensionsResult([factory]);
	const { session } = await createAgentSession({
		cwd: "/tmp",
		modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory("/tmp"),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
	await session.bindExtensions({});
	return { session, settingsManager };
}

describe("extension session-scoped model API", () => {
	it("#given a saved default #when an extension calls setSessionModel #then the session switches and defaults stay", async () => {
		const saved = model("saved-model");
		const other = model("other-model");
		const { session, settingsManager } = await createBoundSession([saved, other], (pi) => {
			pi.on("session_start", async () => {
				await pi.setSessionModel(other);
				pi.setSessionThinkingLevel("high");
			});
		});
		try {
			expect(session.model?.id).toBe("other-model");
			expect(session.thinkingLevel).toBe("high");
			expect(settingsManager.getDefaultModel()).toBe("saved-model");
			expect(settingsManager.getDefaultProvider()).toBe("faux");
			expect(settingsManager.getDefaultThinkingLevel()).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	it("#given a saved default #when an extension calls setModel #then the persisted default follows", async () => {
		const saved = model("saved-model");
		const other = model("other-model");
		const { session, settingsManager } = await createBoundSession([saved, other], (pi) => {
			pi.on("session_start", async () => {
				await pi.setModel(other);
			});
		});
		try {
			expect(session.model?.id).toBe("other-model");
			expect(settingsManager.getDefaultModel()).toBe("other-model");
		} finally {
			session.dispose();
		}
	});
});
