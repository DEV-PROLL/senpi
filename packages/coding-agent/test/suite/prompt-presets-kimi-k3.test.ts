import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	type PromptPresetSettings,
	resolvePreset,
	resolvePresetName,
} from "../../src/core/extensions/builtin/prompt-preset/presets.ts";

function createModel(id: string, provider: string, api: Api = "openai-responses"): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	};
}

function hasKimiK3CatalogSignal(model: Model<Api>): boolean {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	return /(?:^|[/@._-])kimi-k3(?:$|[/@._:-])/.test(searchable);
}

function getKimiK3CatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => (getModels(provider) as Model<Api>[]).filter(hasKimiK3CatalogSignal));
}

function extractSection(prompt: string, heading: string): string {
	const match = prompt.match(new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`));
	return match?.[1] ?? "";
}

describe("Kimi K3 prompt preset", () => {
	it.each([
		{ id: "k3", provider: "kimi-coding", api: "anthropic-messages" as const },
		{ id: "kimi-k3", provider: "moonshotai", api: "anthropic-messages" as const },
		{ id: "kimi-k3", provider: "moonshotai-cn", api: "anthropic-messages" as const },
		{ id: "moonshotai/kimi-k3", provider: "openrouter", api: "openai-responses" as const },
		{ id: "moonshotai/kimi-k3:thinking", provider: "openrouter", api: "openai-responses" as const },
		{ id: "Kimi K3", provider: "custom", api: "openai-responses" as const },
	])("resolves $provider/$id to the kimi-k3 preset", ({ id, provider, api }) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(id, provider, api);

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("kimi-k3");
		expect(preset?.prompt).toContain("You are senpi");
		expect(preset?.prompt).toContain("## Intent Gate");
		expect(preset?.prompt).toContain("running on Kimi K3");
		expect(preset?.prompt).toContain("I'll stop when [the exact, observable condition that ends this turn]");
		expect(preset?.prompt).toContain("evidence-first");
		expect(preset?.prompt).toContain("skip filler verification language");
		expect(preset?.prompt).toContain("a recommendation, not a survey");
		expect(preset?.prompt.length).toBeGreaterThan(2_000);
	});

	it.each([
		"kimi-k2.6-0528",
		"kimi-k2.7-code",
		"kimi-for-coding",
		"kimi-latest",
		"grok-3",
		"deepseek-r1-k3b",
	])("does not route %s to the kimi-k3 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "moonshot");

		// when
		const presetName = resolvePresetName(model, settings);

		// then
		expect(presetName).not.toBe("kimi-k3");
	});

	it("keeps Kimi K3 distinct from the K2.6 and K2.7 presets", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };

		// when
		const k3 = resolvePreset(createModel("kimi-k3", "moonshotai", "anthropic-messages"), settings);
		const k26 = resolvePreset(createModel("kimi-k2.6-0528", "moonshot"), settings);
		const k27 = resolvePreset(createModel("kimi-k2.7-0711", "moonshot"), settings);

		// then
		expect(k3?.name).toBe("kimi-k3");
		expect(k3?.prompt).not.toContain("running on Kimi K2.7");
		expect(k3?.prompt).not.toContain("Avoid restating the user's request");
		expect(k26?.name).toBe("kimi-k2-6");
		expect(k26?.prompt).not.toContain("running on Kimi K3");
		expect(k27?.name).toBe("kimi-k2-7");
		expect(k27?.prompt).not.toContain("running on Kimi K3");
	});

	it("allows settings.json to force kimi-k3 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "kimi-k3" };
		const model = createModel("some-random-model", "custom");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("kimi-k3");
		expect(preset?.prompt).toContain("running on Kimi K3");
	});

	it("respects model-level promptPreset metadata naming kimi-k3", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = {
			...createModel("provider-specific-k3-alias", "custom"),
			promptPreset: "kimi-k3",
		};

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("kimi-k3");
	});

	it("does not include GPT tuning in the kimi-k3 preset", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("kimi-k3", "moonshotai", "anthropic-messages");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("kimi-k3");
		expect(preset?.prompt).not.toContain("apply_patch");
	});

	it("routes surviving ambiguity to a clarifying question instead of an assumption", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("kimi-k3", "moonshotai", "anthropic-messages");

		// when
		const preset = resolvePreset(model, settings);
		const prompt = preset?.prompt ?? "";
		const intentGate = extractSection(prompt, "Intent Gate");
		const style = extractSection(prompt, "Style");

		// then: the reflect-then-ask rule renders inside the Intent Gate, not elsewhere
		expect(intentGate).toMatch(/reread the request once for ambiguity/i);
		// resolution order: context first, trivial gaps filled silently
		expect(intentGate).toMatch(/code, files, and conversation/i);
		expect(intentGate).toMatch(/silently fill trivial gaps/i);
		// terminal condition: surviving material ambiguity -> one specific question, end the turn
		expect(intentGate).toMatch(/material ambiguity survives[\s\S]*?one specific question[\s\S]*?end the turn/i);
		// acting on a fabricated assumption is classified as a defect
		expect(intentGate).toMatch(/invented assumption[\s\S]*?defect/i);
		// the ask rule is stated exactly once across the whole prompt
		expect(prompt.match(/one specific question/g)).toHaveLength(1);
		expect(prompt.match(/reread the request once for ambiguity/gi)).toHaveLength(1);
		// the style permission-begging ban carves out the clarifying question
		expect(style).toMatch(/clarifying question[\s\S]*?not permission-begging/i);
	});

	it("returns kimi-k3 preset for every Kimi K3 built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogModels = getKimiK3CatalogModels();
		const catalogModelIds = catalogModels.map((model) => `${model.provider}/${model.id}`);

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, settings) !== "kimi-k3")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(catalogModelIds).toEqual(
			expect.arrayContaining([
				"kimi-coding/k3",
				"moonshotai/kimi-k3",
				"moonshotai-cn/kimi-k3",
				"openrouter/moonshotai/kimi-k3",
				"vercel-ai-gateway/moonshotai/kimi-k3",
				"opencode-go/kimi-k3",
			]),
		);
		expect(misses).toEqual([]);
	});
});
