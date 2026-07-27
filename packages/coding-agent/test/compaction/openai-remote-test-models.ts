import type { Model } from "@earendil-works/pi-ai";

export const OPENAI_NATIVE_LEGACY_MODEL = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	compat: { supportsRemoteCompactionV2: false },
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
} satisfies Model<"openai-responses">;

export const OPENAI_CANONICAL_LEGACY_MODEL = {
	...OPENAI_NATIVE_LEGACY_MODEL,
	baseUrl: "http://openai.test/v1",
	contextWindow: 10_000,
	maxTokens: 1_000,
} satisfies Model<"openai-responses">;
