import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, registerFauxProvider, type Api, type Model } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import recommendedModelsExtension from "../../src/core/extensions/builtin/recommended-models/index.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelSelectEvent,
	SessionStartEvent,
} from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createAppServerRuntime } from "../../src/modes/app-server/runtime.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { configureModeEnv, scratchRoot, seedFauxConfig } from "./app-server-mode-harness.ts";

type Notice = { message: string; type: "info" | "warning" | "error" | undefined };
type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void> | void;
type ModelSelectHandler = (event: ModelSelectEvent, ctx: ExtensionContext) => Promise<void> | void;

function model(id: string, provider = "faux"): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

interface RecommendedModelsHarness {
	readonly notices: Notice[];
	readonly settings: SettingsManager;
	readonly flags: Map<string, { type: "boolean" | "string"; default?: boolean | string; description?: string }>;
	getActiveModel(): Model<Api>;
	start(provenance: NonNullable<SessionStartEvent["initialModelProvenance"]>): Promise<void>;
	select(model: Model<Api>, source: "set" | "cycle" | "fallback"): Promise<void>;
}

function createHarness(options: {
	active: Model<Api>;
	available: Model<Api>[];
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
	flag?: boolean;
}): RecommendedModelsHarness {
	const settings = SettingsManager.inMemory(options.settings);
	vi.spyOn(SettingsManager, "create").mockReturnValue(settings);

	const notices: Notice[] = [];
	const flags = new Map<string, { type: "boolean" | "string"; default?: boolean | string; description?: string }>();
	const sessionStartHandlers: SessionStartHandler[] = [];
	const modelSelectHandlers: ModelSelectHandler[] = [];
	let activeModel = options.active;
	let thinkingLevel: ThinkingLevel = "medium";

	const ctx = {
		get model() {
			return activeModel;
		},
		modelRegistry: {
			getAvailable: () => options.available,
			hasConfiguredAuth: () => true,
		},
		ui: {
			notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }),
		},
	} as unknown as ExtensionContext;

	const emitModelSelect = async (nextModel: Model<Api>, source: "set" | "cycle" | "fallback"): Promise<void> => {
		const previousModel = activeModel;
		activeModel = nextModel;
		for (const handler of modelSelectHandlers) {
			await handler(
				{
					type: "model_select",
					model: nextModel,
					previousModel,
					source,
					systemPrompt: "",
					systemPromptOptions: { cwd: "/tmp" },
				},
				ctx,
			);
		}
	};

	const pi = {
		registerFlag: (
			name: string,
			options: { type: "boolean" | "string"; default?: boolean | string; description?: string },
		) => flags.set(name, options),
		getFlag: (name: string) => (name === "no-recommended-models" ? options.flag : undefined),
		on: (event: string, handler: SessionStartHandler | ModelSelectHandler) => {
			if (event === "session_start") {
				sessionStartHandlers.push(handler as SessionStartHandler);
			}
			if (event === "model_select") {
				modelSelectHandlers.push(handler as ModelSelectHandler);
			}
		},
		setModel: async (nextModel: Model<Api>) => {
			settings.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
			await emitModelSelect(nextModel, "set");
			return true;
		},
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: (level: ThinkingLevel) => {
			thinkingLevel = level;
			settings.setDefaultThinkingLevel(level);
		},
	} as unknown as ExtensionAPI;

	recommendedModelsExtension(pi);

	return {
		notices,
		settings,
		flags,
		getActiveModel: () => activeModel,
		async start(provenance) {
			for (const handler of sessionStartHandlers) {
				await handler({ type: "session_start", reason: "startup", initialModelProvenance: provenance }, ctx);
			}
		},
		select: emitModelSelect,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("recommended-models builtin", () => {
	it("#given an off-list saved default #when settings provenance starts #then it switches, persists, and notifies", async () => {
		const kimi = model("kimi-k3", "kimi-coding");
		const harness = createHarness({ active: model("off-list"), available: [kimi] });

		await harness.start("settings");

		expect(harness.getActiveModel()).toBe(kimi);
		expect(harness.settings.getDefaultProvider()).toBe("kimi-coding");
		expect(harness.settings.getDefaultModel()).toBe("kimi-k3");
		expect(harness.settings.getDefaultThinkingLevel()).toBe("max");
		expect(harness.notices).toEqual([{ message: "Switched to recommended model 'kimi-k3'.", type: "info" }]);
	});

	it("#given no available recommendation #when settings provenance starts #then it warns once with the prescribed text", async () => {
		const harness = createHarness({ active: model("off-list"), available: [] });

		await harness.start("settings");
		await harness.select(model("another-off-list"), "fallback");

		expect(harness.notices).toEqual([
			{
				message:
					"Non-recommended model 'off-list': odd behavior is the default state; a working session is the anomaly.",
				type: "warning",
			},
		]);
	});

	it("#given recommended warnings are disabled #when a session starts #then it neither switches nor warns", async () => {
		const kimi = model("kimi-k3", "kimi-coding");
		const harness = createHarness({
			active: model("off-list"),
			available: [kimi],
			settings: { warnings: { offRecommendedModel: true } },
		});

		await harness.start("settings");

		expect(harness.getActiveModel().id).toBe("off-list");
		expect(harness.settings.getDefaultModel()).toBeUndefined();
		expect(harness.notices).toEqual([]);
	});

	it("#given a recommendedModels override #when a session starts #then it follows the override priority", async () => {
		const kimi = model("kimi-k3", "kimi-coding");
		const glm = model("glm-5.2", "zai-coding-plan");
		const harness = createHarness({
			active: model("off-list"),
			available: [kimi, glm],
			settings: { recommendedModels: ["glm-5.2"] },
		});

		await harness.start("provider-default");

		expect(harness.getActiveModel()).toBe(glm);
		expect(harness.settings.getDefaultThinkingLevel()).toBe("max");
	});

	it("#given suffix and k3 aliases #when the active model is already recommended #then it keeps the active model", async () => {
		for (const activeId of ["gpt-5.6-sol-fast", "kimi-k3-ultrafast", "k3"]) {
			const harness = createHarness({
				active: model(activeId),
				available: [model("kimi-k3", "kimi-coding"), model("gpt-5.6-sol", "openai")],
			});

			await harness.start("first-available");

			expect(harness.getActiveModel().id).toBe(activeId);
			expect(harness.notices).toEqual([]);
		}
	});

	it("#given cli or scoped provenance #when an off-list model starts #then it never switches or persists", async () => {
		for (const provenance of ["cli", "scoped"] as const) {
			const harness = createHarness({ active: model("off-list"), available: [model("kimi-k3", "kimi-coding")] });

			await harness.start(provenance);

			expect(harness.getActiveModel().id).toBe("off-list");
			expect(harness.settings.getDefaultModel()).toBeUndefined();
			expect(harness.notices).toEqual([]);
		}
	});

	it("#given the run flag #when a session starts #then it leaves recommended-model behavior disabled", async () => {
		const harness = createHarness({
			active: model("off-list"),
			available: [model("kimi-k3", "kimi-coding")],
			flag: true,
		});

		await harness.start("settings");

		expect(harness.flags.get("no-recommended-models")).toEqual({
			type: "boolean",
			default: false,
			description: "Disable recommended model selection for this run.",
		});
		expect(harness.getActiveModel().id).toBe("off-list");
		expect(harness.notices).toEqual([]);
	});

	it("#given settings selection #when the SDK emits session_start #then the provenance reaches extensions", async () => {
		const saved = model("off-list");
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(saved.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: null,
			allowModelNetwork: false,
		});
		modelRuntime.registerProvider(saved.provider, {
			baseUrl: saved.baseUrl,
			api: saved.api,
			models: [
				{
					id: saved.id,
					name: saved.name,
					api: saved.api,
					reasoning: saved.reasoning,
					input: saved.input,
					cost: saved.cost,
					contextWindow: saved.contextWindow,
					maxTokens: saved.maxTokens,
				},
			],
		});
		const events: SessionStartEvent[] = [];
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("session_start", (event) => {
					events.push(event);
				});
			},
		]);
		const { session } = await createAgentSession({
			cwd: "/tmp",
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ defaultProvider: saved.provider, defaultModel: saved.id }),
			sessionManager: SessionManager.inMemory("/tmp"),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		try {
			await session.bindExtensions({});
			expect(events).toEqual([{ type: "session_start", reason: "startup", initialModelProvenance: "settings" }]);
		} finally {
			session.dispose();
		}
	});

	it("#given an app-server faux settings default #when recommended models initialize #then the faux model remains selected", async () => {
		const root = await scratchRoot();
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("faux response")]);
		await seedFauxConfig(root, faux);
		configureModeEnv(root);
		const runtime = createAppServerRuntime(() => {});
		const entry = await runtime.threads.createThread({ cwd: root });
		try {
			expect(entry.session.model?.provider).toBe(faux.getModel().provider);
			expect(entry.session.model?.id).toBe(faux.getModel().id);

			await entry.session.prompt("use the configured faux model");

			expect(faux.state.callCount).toBe(1);
		} finally {
			entry.session.dispose();
			runtime.dispose();
			faux.unregister();
		}
	});

	it("#given builtin registration #when extensions are enumerated #then recommended-models can be disabled by id", () => {
		expect(builtinExtensions.some((extension) => extension.id === "recommended-models")).toBe(true);
	});
});
