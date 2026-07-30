import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ZAI_MODELS } from "./zai.models.ts";

const zaiModels = Object.values(ZAI_MODELS).map((model) =>
	model.id === "glm-5.1" || model.id === "glm-5.2"
		? { ...model, compat: { ...model.compat, maxTokensField: "max_tokens" as const } }
		: model,
);

export function zaiProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "zai",
		name: "Z.AI",
		baseUrl: "https://api.z.ai/api/coding/paas/v4",
		auth: { apiKey: envApiKeyAuth("Z.AI API key", ["ZAI_API_KEY"]) },
		models: zaiModels,
		api: openAICompletionsApi(),
	});
}
