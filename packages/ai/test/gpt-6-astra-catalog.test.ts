import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels, supportsMax, supportsXhigh } from "../src/compat.ts";

const EXPECTED_COST = {
	input: 10,
	output: 50,
	cacheRead: 1,
	cacheWrite: 12.5,
	tiers: [{ inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
};

for (const provider of ["openai", "openai-codex"] as const) {
	describe(`${provider}/gpt-6-astra`, () => {
		it("has the published catalog metadata and long-context pricing", () => {
			const model = getModel(provider, "gpt-6-astra");
			expect(model).toMatchObject({
				id: "gpt-6-astra",
				name: "GPT-6 Astra",
				api: "openai-responses",
				provider,
				baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 272000,
				maxTokens: 128000,
				cost: EXPECTED_COST,
			});
		});

		it("exposes only the supported reasoning efforts", () => {
			const model = getModel(provider, "gpt-6-astra")!;
			expect(model.thinkingLevelMap).toMatchObject({ off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
			expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
			expect(supportsXhigh(model)).toBe(true);
			expect(supportsMax(model)).toBe(true);
		});

		it("has a priority fast variant", () => {
			const fast = getModel(provider, "gpt-6-astra-fast");
			expect(fast).toMatchObject({ id: "gpt-6-astra-fast", upstreamModelId: "gpt-6-astra", serviceTier: "priority" });
		});
	});
}
