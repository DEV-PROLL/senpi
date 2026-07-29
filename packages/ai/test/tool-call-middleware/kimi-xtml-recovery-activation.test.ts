import { describe, expect, it } from "vitest";
import { shouldRecoverTextToolCalls } from "../../src/index.ts";
import { getToolCallFormat } from "../../src/tool-call-middleware/index.ts";
import type { Model } from "../../src/types.ts";

function createModel(id: string, overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		...overrides,
	};
}

describe("kimi recovery activation", () => {
	it("defaults recovery on for Kimi-family identifiers like the Claude family", () => {
		for (const id of [
			"kimi-k3",
			"kimi-k3-ultrafast",
			"kimi-k3-256k",
			"kimi-k2-thinking",
			"kimi-for-coding-highspeed",
			"moonshot/kimi-k3",
			"apitopia/kimi-k3-unlocked",
			"x-kimi",
			"KIMI-K3",
		]) {
			expect(shouldRecoverTextToolCalls(createModel(id)), id).toBe(true);
		}
	});

	it("rejects substring false positives", () => {
		for (const id of ["kimiko", "sikimi", "kimi3", "grokimi", "kimiai"]) {
			expect(shouldRecoverTextToolCalls(createModel(id)), id).toBe(false);
		}
	});

	it("keeps text-protocol mutual exclusion precedence for kimi-xtml", () => {
		const model = createModel("kimi-k3", {
			recoverTextToolCalls: true,
			compat: { toolCallFormat: "kimi-xtml" },
		});
		expect(getToolCallFormat(model)).toBe("kimi-xtml");
		expect(shouldRecoverTextToolCalls(model)).toBe(false);
	});

	it("honors the explicit recoverTextToolCalls override on kimi models", () => {
		expect(shouldRecoverTextToolCalls(createModel("kimi-k3", { recoverTextToolCalls: false }))).toBe(false);
		expect(shouldRecoverTextToolCalls(createModel("gpt-5", { recoverTextToolCalls: true }))).toBe(true);
	});
});
