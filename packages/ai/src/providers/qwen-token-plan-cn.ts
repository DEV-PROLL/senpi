import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { QWEN_TOKEN_PLAN_CN_MODELS } from "./qwen-token-plan-cn.models.ts";

const QWEN_TOKEN_PLAN_REASONING_EFFORT_UNSUPPORTED_MODEL_IDS = new Set([
	"MiniMax-M2.5",
	"deepseek-v3.2",
	"kimi-k2.5",
	"kimi-k2.6",
	"kimi-k2.7-code",
	"qwen3.6-flash",
	"qwen3.6-plus",
	"qwen3.7-max",
	"qwen3.7-plus",
]);

const QWEN_TOKEN_PLAN_HIGH_MAX_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;

const QWEN_TOKEN_PLAN_QWEN38_THINKING_LEVEL_MAP = {
	minimal: null,
	low: "low",
	medium: "medium",
	high: null,
	xhigh: "xhigh",
	max: null,
} as const;

const qwenTokenPlanCnModels = Object.values(QWEN_TOKEN_PLAN_CN_MODELS).map((model) => {
	const supportsReasoningEffort = !QWEN_TOKEN_PLAN_REASONING_EFFORT_UNSUPPORTED_MODEL_IDS.has(model.id);
	return {
		...model,
		compat: {
			...model.compat,
			thinkingFormat: "qwen" as const,
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort,
		},
		...(supportsReasoningEffort
			? {
					thinkingLevelMap:
						model.id === "qwen3.8-max-preview"
							? QWEN_TOKEN_PLAN_QWEN38_THINKING_LEVEL_MAP
							: QWEN_TOKEN_PLAN_HIGH_MAX_THINKING_LEVEL_MAP,
				}
			: {}),
	};
});

export function qwenTokenPlanCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qwen-token-plan-cn",
		name: "Qwen Token Plan CN",
		baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		auth: { apiKey: envApiKeyAuth("Qwen Token Plan CN API key", ["QWEN_TOKEN_PLAN_CN_API_KEY"]) },
		models: qwenTokenPlanCnModels,
		api: openAICompletionsApi(),
	});
}
