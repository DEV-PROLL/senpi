import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildHighReasoningWarning,
	isSensitiveHighReasoningModel,
	shouldWarnHighReasoning,
} from "../src/core/high-reasoning-warning.ts";

function mkModel(id: string, provider = "openai"): Model<Api> {
	return { id, provider, reasoning: true, api: "openai-responses" } as unknown as Model<Api>;
}

describe("high-reasoning-warning", () => {
	describe("isSensitiveHighReasoningModel", () => {
		it("flags gpt-5.6-sol-like frontier models (provider-agnostic, name-based)", () => {
			expect(isSensitiveHighReasoningModel(mkModel("gpt-5.6-sol"))).toBe(true);
			expect(isSensitiveHighReasoningModel(mkModel("gpt-5.6"))).toBe(true);
			expect(isSensitiveHighReasoningModel(mkModel("gpt-5.2-mini"))).toBe(true);
			expect(isSensitiveHighReasoningModel(mkModel("claude-opus-4-8"))).toBe(true);
			expect(isSensitiveHighReasoningModel(mkModel("opus-4.7"))).toBe(true);
			expect(isSensitiveHighReasoningModel(mkModel("fable-5"))).toBe(true);
			expect(isSensitiveHighReasoningModel(mkModel("deepseek-v4-pro"))).toBe(true);
			expect(isSensitiveHighReasoningModel(mkModel("deepseek-v4-flash"))).toBe(true);
			expect(isSensitiveHighReasoningModel(mkModel("gpt-5.6-sol", "openrouter"))).toBe(true);
		});

		it("does not flag non-frontier models", () => {
			expect(isSensitiveHighReasoningModel(mkModel("gpt-4o"))).toBe(false);
			expect(isSensitiveHighReasoningModel(mkModel("claude-3-5-sonnet"))).toBe(false);
			expect(isSensitiveHighReasoningModel(mkModel("gpt-5"))).toBe(false);
			expect(isSensitiveHighReasoningModel(mkModel("llama-3.3-70b"))).toBe(false);
		});
	});

	describe("shouldWarnHighReasoning", () => {
		it("warns for a sensitive model driven at xhigh or max", () => {
			expect(shouldWarnHighReasoning(mkModel("gpt-5.6-sol"), "xhigh")).toBe(true);
			expect(shouldWarnHighReasoning(mkModel("gpt-5.6-sol"), "max")).toBe(true);
			expect(shouldWarnHighReasoning(mkModel("claude-opus-4-8"), "max")).toBe(true);
			expect(shouldWarnHighReasoning(mkModel("fable-5"), "xhigh")).toBe(true);
		});

		it("does not warn for a non-sensitive model even at xhigh/max", () => {
			expect(shouldWarnHighReasoning(mkModel("gpt-4o"), "xhigh")).toBe(false);
			expect(shouldWarnHighReasoning(mkModel("gpt-4o"), "max")).toBe(false);
		});

		it("does not warn for a sensitive model at or below high", () => {
			expect(shouldWarnHighReasoning(mkModel("gpt-5.6-sol"), "high")).toBe(false);
			expect(shouldWarnHighReasoning(mkModel("gpt-5.6-sol"), "medium")).toBe(false);
			expect(shouldWarnHighReasoning(mkModel("gpt-5.6-sol"), "low")).toBe(false);
			expect(shouldWarnHighReasoning(mkModel("gpt-5.6-sol"), "minimal")).toBe(false);
			expect(shouldWarnHighReasoning(mkModel("gpt-5.6-sol"), "off")).toBe(false);
		});
	});

	describe("buildHighReasoningWarning", () => {
		it("produces a scary warning that names the model+level and urges ultrabrain", () => {
			const w = buildHighReasoningWarning(mkModel("gpt-5.6-sol", "openai"), "xhigh");
			expect(w.title).toMatch(/WARNING/i);
			expect(w.title).toContain("gpt-5.6-sol");
			expect(w.title).toContain("xhigh");
			const body = w.body.join("\n");
			expect(body).toMatch(/ultrabrain/i);
			expect(body).toMatch(/responsibilit/i);
			expect(body).toMatch(/stop|loop|halt/i);
			expect(body).toMatch(/unrequested|not asked|not requested/i);
			expect(body).toMatch(/risk|irreversible|dangerous/i);
			expect(body).toMatch(/query ultrabrain|delegate|subagent|sub-agent/i);
			expect(body.length).toBeGreaterThan(200);
		});

		it("reflects the max level in the title when max is selected", () => {
			const w = buildHighReasoningWarning(mkModel("claude-opus-4-8", "anthropic"), "max");
			expect(w.title).toContain("max");
			expect(w.title).toContain("claude-opus-4-8");
		});
	});
});
