import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import recommendedModelsExtension from "../../src/core/extensions/builtin/recommended-models/index.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionMode,
	ModelSelectEvent,
	SessionStartEvent,
} from "../../src/core/extensions/types.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

export type Notice = { message: string; type: "info" | "warning" | "error" | undefined };
type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void> | void;
type ModelSelectHandler = (event: ModelSelectEvent, ctx: ExtensionContext) => Promise<void> | void;

export function model(id: string, provider = "faux"): Model<Api> {
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

export interface RecommendedModelsHarness {
	readonly notices: Notice[];
	readonly settings: SettingsManager;
	readonly flags: Map<string, { type: "boolean" | "string"; default?: boolean | string; description?: string }>;
	getActiveModel(): Model<Api>;
	getThinkingLevel(): ThinkingLevel;
	start(provenance: NonNullable<SessionStartEvent["initialModelProvenance"]>): Promise<void>;
	select(model: Model<Api>, source: "set" | "cycle" | "fallback"): Promise<void>;
}

export function createHarness(options: {
	active: Model<Api>;
	available: Model<Api>[];
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
	flag?: boolean;
	mode?: ExtensionMode;
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
		mode: options.mode ?? "tui",
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
			flagOptions: { type: "boolean" | "string"; default?: boolean | string; description?: string },
		) => flags.set(name, flagOptions),
		getFlag: (name: string) => (name === "no-recommended-models" ? options.flag : undefined),
		on: (event: string, handler: SessionStartHandler | ModelSelectHandler) => {
			if (event === "session_start") {
				sessionStartHandlers.push(handler as SessionStartHandler);
			}
			if (event === "model_select") {
				modelSelectHandlers.push(handler as ModelSelectHandler);
			}
		},
		// Mirrors the real API contract: setModel persists the global default.
		setModel: async (nextModel: Model<Api>) => {
			settings.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
			await emitModelSelect(nextModel, "set");
			return true;
		},
		// Mirrors the real API contract: setSessionModel never touches persisted defaults.
		setSessionModel: async (nextModel: Model<Api>) => {
			await emitModelSelect(nextModel, "set");
			return true;
		},
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: (level: ThinkingLevel) => {
			thinkingLevel = level;
			settings.setDefaultThinkingLevel(level);
		},
		setSessionThinkingLevel: (level: ThinkingLevel) => {
			thinkingLevel = level;
		},
	} as unknown as ExtensionAPI;

	recommendedModelsExtension(pi);

	return {
		notices,
		settings,
		flags,
		getActiveModel: () => activeModel,
		getThinkingLevel: () => thinkingLevel,
		async start(provenance) {
			for (const handler of sessionStartHandlers) {
				await handler({ type: "session_start", reason: "startup", initialModelProvenance: provenance }, ctx);
			}
		},
		select: emitModelSelect,
	};
}
