import { describe, expect, it } from "vitest";
import { collectTips } from "../../src/cli/list-tips.ts";
import { TIP_DEFINITIONS } from "../../src/modes/interactive/tips/registry.ts";

describe("collectTips", () => {
	it("returns every catalog tip in order with non-empty rendered text", () => {
		const tips = collectTips();

		expect(tips.map((tip) => tip.id)).toEqual(TIP_DEFINITIONS.map((tip) => tip.id));
		for (const tip of tips) {
			expect(tip.text.trim(), tip.id).not.toBe("");
			expect(tip.text, tip.id).not.toContain("undefined");
		}
	});

	it("includes the fallback-chains-setting tip", () => {
		const tips = collectTips();

		expect(tips.some((tip) => tip.id === "fallback-chains-setting")).toBe(true);
	});

	it("carries requiresCommand only for command-gated tips", () => {
		const tips = collectTips();
		const gated = tips.filter((tip) => tip.requiresCommand !== undefined);

		expect(gated.length).toBeGreaterThan(0);
		for (const tip of gated) {
			const definition = TIP_DEFINITIONS.find((candidate) => candidate.id === tip.id);
			expect(definition?.requiresCommand).toBe(tip.requiresCommand);
		}
		for (const tip of tips.filter((candidate) => candidate.requiresCommand === undefined)) {
			expect(TIP_DEFINITIONS.find((candidate) => candidate.id === tip.id)?.requiresCommand).toBeUndefined();
		}
	});
});
