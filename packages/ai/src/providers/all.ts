import { createImagesModels, type ImagesProvider, type MutableImagesModels } from "../images-models.ts";
import { MODELS } from "../models.generated.ts";
import { type CreateModelsOptions, createModels, type MutableModels, type Provider } from "../models.ts";
import type { Api, Model, ThinkingLevelMap } from "../types.ts";
import { alibabaTokenPlanProvider } from "./alibaba-token-plan.ts";
import { amazonBedrockProvider } from "./amazon-bedrock.ts";
import { antLingProvider } from "./ant-ling.ts";
import { anthropicProvider } from "./anthropic.ts";
import { azureOpenAIResponsesProvider } from "./azure-openai-responses.ts";
import { cerebrasProvider } from "./cerebras.ts";
import { cloudflareAIGatewayProvider } from "./cloudflare-ai-gateway.ts";
import { cloudflareWorkersAIProvider } from "./cloudflare-workers-ai.ts";
import modelDataManifest from "./data/.manifest.json" with { type: "json" };
import { deepseekProvider } from "./deepseek.ts";
import { fireworksProvider } from "./fireworks.ts";
import { githubCopilotProvider } from "./github-copilot.ts";
import { googleProvider } from "./google.ts";
import { googleVertexProvider } from "./google-vertex.ts";
import { groqProvider } from "./groq.ts";
import { huggingfaceProvider } from "./huggingface.ts";
import { kimiCodingProvider } from "./kimi-coding.ts";
import { minimaxProvider } from "./minimax.ts";
import { minimaxCnProvider } from "./minimax-cn.ts";
import { mistralProvider } from "./mistral.ts";
import { moonshotaiProvider } from "./moonshotai.ts";
import { moonshotaiCnProvider } from "./moonshotai-cn.ts";
import { nvidiaProvider } from "./nvidia.ts";
import { openaiProvider } from "./openai.ts";
import { openaiCodexProvider } from "./openai-codex.ts";
import { opencodeProvider } from "./opencode.ts";
import { opencodeGoProvider } from "./opencode-go.ts";
import { openrouterProvider } from "./openrouter.ts";
import { openrouterImagesProvider } from "./openrouter-images.ts";
import { qwenTokenPlanProvider } from "./qwen-token-plan.ts";
import { qwenTokenPlanCnProvider } from "./qwen-token-plan-cn.ts";
import { radiusProvider } from "./radius.ts";
import { togetherProvider } from "./together.ts";
import { vercelAIGatewayProvider } from "./vercel-ai-gateway.ts";
import { xaiProvider } from "./xai.ts";
import { xiaomiProvider } from "./xiaomi.ts";
import { xiaomiTokenPlanAmsProvider } from "./xiaomi-token-plan-ams.ts";
import { xiaomiTokenPlanCnProvider } from "./xiaomi-token-plan-cn.ts";
import { xiaomiTokenPlanSgpProvider } from "./xiaomi-token-plan-sgp.ts";
import { zaiProvider } from "./zai.ts";
import { zaiCodingCnProvider } from "./zai-coding-cn.ts";

export { radiusProvider };

/** Providers present in the generated catalog. `KnownProvider` additionally
 * includes purely dynamic providers (e.g. "radius") that have no static
 * catalog entry. */
export type BuiltinProvider = keyof typeof MODELS;

type BuiltinModelApi<
	TProvider extends BuiltinProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

const XIAOMI_MIMO_PROVIDERS = new Set([
	"xiaomi",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-sgp",
]);

const ADAPTIVE_THINKING_MAX_MARKERS = [
	"opus-4-6",
	"opus-4-7",
	"opus-4-8",
	"opus-5",
	"sonnet-4-6",
	"sonnet-5",
	"fable-5",
] as const;
const ADAPTIVE_THINKING_XHIGH_MARKERS = ["opus-4-7", "opus-4-8", "opus-5", "sonnet-5", "fable-5"] as const;

function getModelMatchCandidates<TApi extends Api>(model: Model<TApi>): string[] {
	return [model.id, model.name].flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
}

function matchesModelMarker<TApi extends Api>(model: Model<TApi>, markers: readonly string[]): boolean {
	const candidates = getModelMatchCandidates(model);
	return candidates.some((candidate) => markers.some((marker) => candidate.includes(marker)));
}

function normalizeAdaptiveAnthropicModel<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	if (model.api !== "anthropic-messages" || !matchesModelMarker(model, ADAPTIVE_THINKING_MAX_MARKERS)) return model;

	const compat = model.compat as Model<"anthropic-messages">["compat"] | undefined;
	const thinkingLevelMap: ThinkingLevelMap = { ...model.thinkingLevelMap, max: "max" };
	if (matchesModelMarker(model, ADAPTIVE_THINKING_XHIGH_MARKERS)) {
		thinkingLevelMap.xhigh = "xhigh";
	}

	return {
		...model,
		thinkingLevelMap,
		compat: {
			...compat,
			forceAdaptiveThinking: compat?.forceAdaptiveThinking ?? true,
		},
	} as Model<TApi>;
}

function normalizeBuiltinModel<TApi extends Api>(model: Model<TApi> | undefined): Model<TApi> | undefined {
	if (!model) return undefined;

	if (XIAOMI_MIMO_PROVIDERS.has(model.provider) && model.id === "mimo-v2.5-pro") {
		return {
			...model,
			compat: {
				...model.compat,
				requiresReasoningContentOnAssistantMessages: true,
				thinkingFormat: "deepseek",
				supportsDisabledThinking: false,
			},
		} as Model<TApi>;
	}

	if (model.provider === "anthropic" && model.id === "claude-opus-4-8") {
		return {
			...model,
			thinkingLevelMap: {
				...model.thinkingLevelMap,
				max: "max",
			},
		};
	}

	return normalizeAdaptiveAnthropicModel(model);
}

/** Typed read of the generated built-in catalog. */
export function getBuiltinModel<TProvider extends BuiltinProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<BuiltinModelApi<TProvider, TModelId>> {
	const models = MODELS[provider] as Record<string, Model<Api>> | undefined;
	return normalizeBuiltinModel(models?.[modelId as string]) as Model<BuiltinModelApi<TProvider, TModelId>>;
}

export function getBuiltinProviders(): BuiltinProvider[] {
	return Object.keys(MODELS) as BuiltinProvider[];
}

/** Generation timestamp shared by all built-in provider catalogs. */
export function getBuiltinModelDataGeneratedAt(): number | undefined {
	const generatedAt = Date.parse(modelDataManifest.generatedAt);
	return Number.isNaN(generatedAt) ? undefined : generatedAt;
}

export function getBuiltinModels<TProvider extends BuiltinProvider>(
	provider: TProvider,
): Model<BuiltinModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = MODELS[provider] as Record<string, Model<Api>> | undefined;
	return models
		? (Object.values(models)
				.map((model) => normalizeBuiltinModel(model))
				.filter((model): model is Model<Api> => model !== undefined) as Model<
				BuiltinModelApi<TProvider, keyof (typeof MODELS)[TProvider]>
			>[])
		: [];
}

/** All built-in providers, freshly constructed. */
export function builtinProviders(): Provider[] {
	return [
		alibabaTokenPlanProvider(),
		amazonBedrockProvider(),
		antLingProvider(),
		anthropicProvider(),
		azureOpenAIResponsesProvider(),
		cerebrasProvider(),
		cloudflareAIGatewayProvider(),
		cloudflareWorkersAIProvider(),
		deepseekProvider(),
		fireworksProvider(),
		githubCopilotProvider(),
		googleProvider(),
		googleVertexProvider(),
		groqProvider(),
		huggingfaceProvider(),
		kimiCodingProvider(),
		minimaxProvider(),
		minimaxCnProvider(),
		mistralProvider(),
		moonshotaiProvider(),
		moonshotaiCnProvider(),
		nvidiaProvider(),
		openaiProvider(),
		openaiCodexProvider(),
		opencodeProvider(),
		opencodeGoProvider(),
		openrouterProvider(),
		qwenTokenPlanProvider(),
		qwenTokenPlanCnProvider(),
		radiusProvider(),
		togetherProvider(),
		vercelAIGatewayProvider(),
		xaiProvider(),
		xiaomiProvider(),
		xiaomiTokenPlanAmsProvider(),
		xiaomiTokenPlanCnProvider(),
		xiaomiTokenPlanSgpProvider(),
		zaiProvider(),
		zaiCodingCnProvider(),
	];
}

/** A `Models` collection with every built-in provider registered. */
export function builtinModels(options?: CreateModelsOptions): MutableModels {
	const models = createModels(options);
	for (const provider of builtinProviders()) {
		models.setProvider(provider);
	}
	return models;
}

/** All built-in image-generation providers, freshly constructed. */
export function builtinImagesProviders(): ImagesProvider[] {
	return [openrouterImagesProvider()];
}

/** An `ImagesModels` collection with every built-in image-generation provider registered. */
export function builtinImagesModels(options?: CreateModelsOptions): MutableImagesModels {
	const models = createImagesModels(options);
	for (const provider of builtinImagesProviders()) {
		models.setProvider(provider);
	}
	return models;
}
