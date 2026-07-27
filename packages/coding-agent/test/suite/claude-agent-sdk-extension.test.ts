import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type Api, type Context, type Model } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import claudeAgentSdkExtension, {
	CLAUDE_AGENT_SDK_PROVIDER_ID,
} from "../../src/core/extensions/builtin/claude-agent-sdk/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { ProviderConfigInput } from "../../src/core/provider-composer.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";

type Registration = { name: string; config: ProviderConfigInput };

function captureRegistration(): { registration: Registration } {
	let captured: Registration | undefined;
	const pi = {
		registerProvider: (name: string, config: ProviderConfigInput) => {
			captured = { name, config };
		},
	} as unknown as ExtensionAPI;
	claudeAgentSdkExtension(pi);
	if (!captured) throw new Error("extension did not register a provider");
	return { registration: captured };
}

function fakeStreamSimple() {
	return () => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: undefined as never });
		stream.end();
		return stream;
	};
}

async function createRuntimeWithProvider(config: ProviderConfigInput, storage = AuthStorage.inMemory()) {
	const runtime = await ModelRuntime.create({ credentials: storage, modelsPath: null, allowModelNetwork: false });
	await runtime.registerProvider(CLAUDE_AGENT_SDK_PROVIDER_ID, config);
	return runtime;
}

describe("claude-agent-sdk builtin provider", () => {
	it("registers the provider with sentinel auth, catalog models and a stream fn", () => {
		const { registration } = captureRegistration();
		expect(registration.name).toBe(CLAUDE_AGENT_SDK_PROVIDER_ID);
		expect(registration.config.baseUrl).toBe(CLAUDE_AGENT_SDK_PROVIDER_ID);
		expect(registration.config.models?.length).toBeGreaterThan(0);
		expect(typeof registration.config.streamSimple).toBe("function");
	});

	it("lists claude-agent-sdk models in the runtime registry", async () => {
		const { registration } = captureRegistration();
		const runtime = await createRuntimeWithProvider(registration.config);
		const ids = (await runtime.getAvailable()).map((model) => `${model.provider}/${model.id}`);
		expect(ids.some((id) => id.startsWith(`${CLAUDE_AGENT_SDK_PROVIDER_ID}/`))).toBe(true);
	});

	it("login selector lists the provider as oauth after registration", async () => {
		const { registration } = captureRegistration();
		const storage = AuthStorage.inMemory();
		await createRuntimeWithProvider(registration.config, storage);
		expect(storage.getOAuthProviders()).toContainEqual({
			id: CLAUDE_AGENT_SDK_PROVIDER_ID,
			name: "Claude Agent SDK (Claude Pro/Max)",
		});
	});

	it("preflight reaches streamSimple with zero stored credentials", async () => {
		const { registration } = captureRegistration();
		let called = false;
		const config: ProviderConfigInput = {
			...registration.config,
			streamSimple: (model: Model<Api>, context: Context) => {
				called = true;
				return fakeStreamSimple()(model, context);
			},
		};
		const runtime = await createRuntimeWithProvider(config);
		const model = (await runtime.getAvailable(CLAUDE_AGENT_SDK_PROVIDER_ID))[0];
		expect(model).toBeDefined();
		const stream = runtime.streamSimple(model as Model<Api>, { messages: [], tools: [] } as unknown as Context);
		for await (const event of stream) void event;
		expect(called).toBe(true);
	});
});
