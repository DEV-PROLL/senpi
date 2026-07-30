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

	it("lists the omo-senpi coding workflow skills", () => {
		const expectedTips = [
			{
				id: "workflow-skills.init-deep",
				text: 'Trigger "/init-deep" to map a project and generate a hierarchical AGENTS.md knowledge base.',
				requiresCommand: "tasks",
			},
			{
				id: "workflow-skills.debugging",
				text: 'Trigger "debug this" for parallel hypotheses, a failing regression test, a minimal fix, and real-surface QA.',
				requiresCommand: "tasks",
			},
			{
				id: "workflow-skills.refactor",
				text: 'Trigger "refactor" for codebase-aware cleanup that pins behavior before changing structure.',
				requiresCommand: "tasks",
			},
			{
				id: "workflow-skills.remove-ai-slops",
				text: 'Trigger "remove AI slop" to lock behavior first, then strip generated-code smells without drive-by rewrites.',
				requiresCommand: "tasks",
			},
			{
				id: "workflow-skills.visual-qa",
				text: 'Trigger "visual QA" to capture browser or xterm evidence and review web or terminal interfaces.',
				requiresCommand: "tasks",
			},
		];
		const expectedIds = new Set(expectedTips.map((tip) => tip.id));

		expect(collectTips().filter((tip) => expectedIds.has(tip.id))).toEqual(expectedTips);
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
