import { describe, expect, it } from "vitest";
import { TIP_DEFINITIONS } from "../../src/modes/interactive/tips/registry.ts";

const ETHOS_IDS = [
	"ethos.tuning-discipline",
	"ethos.tools-transparent",
	"ethos.only-harness",
	"ethos.spend-tokens",
	"ethos.deep-work",
	"ethos.ulw-plan-sage",
	"ethos.ulw-loop-shallow",
] as const;

const noopKeys = (): string => "";

describe("ethos tips", () => {
	it("registers every ethos tip id", () => {
		const ids = new Set(TIP_DEFINITIONS.map((tip) => tip.id));

		for (const id of ETHOS_IDS) {
			expect(ids, `missing ${id}`).toContain(id);
		}
	});

	it("renders the approved English copy verbatim", () => {
		const byId = new Map(TIP_DEFINITIONS.map((tip) => [tip.id, tip.render(noopKeys)]));

		expect(byId.get("ethos.tuning-discipline")).toBe(
			"gpt-5.6-sol used to turn a sprint into a marathon. We tuned the system prompt and killed that habit: 5-minute jobs take 5 minutes, 12-hour jobs take 12.",
		);
		expect(byId.get("ethos.tools-transparent")).toBe(
			"Don't study our tools. A tool that needs studying is a tool that failed. We just ride shotgun while you keep doing your actual job.",
		);
		expect(byId.get("ethos.only-harness")).toBe(
			"The only harness that actually knows how to drive gpt-5.6-sol. Same job, feels up to 30% faster. *we counted*",
		);
		expect(byId.get("ethos.spend-tokens")).toBe(
			"Stop hoarding tokens. Spend them like they buy your hours back, because they do.",
		);
		expect(byId.get("ethos.deep-work")).toBe(
			"Using our tools means your work is already the deep, valuable kind. Keep your eyes on the essence of your craft. The rest is our problem now, and we're great at problems.",
		);
		expect(byId.get("ethos.ulw-plan-sage")).toBe(
			"Try ulw-plan on fable-5 xhigh. A patient sage obsessed with the essence does the agonizing for you and fills in every blank you were pretending not to see.",
		);
		expect(byId.get("ethos.ulw-loop-shallow")).toBe(
			"For days when deep thought sounds awful, run the ulw loop with gpt-5.6-sol fast/medium. Fair warning: shallow thinking sends invoices.",
		);
	});

	it("gates the ulw command tips on the tasks command", () => {
		const byId = new Map(TIP_DEFINITIONS.map((tip) => [tip.id, tip]));

		expect(byId.get("ethos.ulw-plan-sage")?.requiresCommand).toBe("tasks");
		expect(byId.get("ethos.ulw-loop-shallow")?.requiresCommand).toBe("tasks");
	});

	it("leaves the pure manifesto tips unbound and ungated", () => {
		const byId = new Map(TIP_DEFINITIONS.map((tip) => [tip.id, tip]));

		for (const id of [
			"ethos.tuning-discipline",
			"ethos.tools-transparent",
			"ethos.only-harness",
			"ethos.spend-tokens",
			"ethos.deep-work",
		] as const) {
			const tip = byId.get(id);
			expect(tip?.bindings, id).toEqual([]);
			expect(tip?.requiresCommand, id).toBeUndefined();
		}
	});
});
