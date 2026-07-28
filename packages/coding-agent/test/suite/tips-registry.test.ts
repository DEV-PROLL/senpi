import { describe, expect, it } from "vitest";
import { KEYBINDINGS, type Keybinding, KeybindingsManager } from "../../src/core/keybindings.ts";
import { TIP_DEFINITIONS } from "../../src/modes/interactive/tips/registry.ts";
import { selectTip } from "../../src/modes/interactive/tips/scheduler.ts";

const manager = new KeybindingsManager();
const liveKeys = (binding: Keybinding): string => manager.getKeys(binding).join("/");

describe("TIP_DEFINITIONS", () => {
	it("has unique ids", () => {
		const ids = TIP_DEFINITIONS.map((tip) => tip.id);

		expect(new Set(ids).size).toBe(ids.length);
	});

	it("declares only real keybindings", () => {
		const unknown = TIP_DEFINITIONS.flatMap((tip) => tip.bindings).filter((binding) => !(binding in KEYBINDINGS));

		expect(unknown).toEqual([]);
	});

	it("renders every tip to a single non-empty line with live keys", () => {
		for (const tip of TIP_DEFINITIONS) {
			const body = tip.render(liveKeys);

			expect(body.trim(), tip.id).not.toBe("");
			expect(body, tip.id).not.toContain("\n");
			expect(body, tip.id).not.toContain("undefined");
		}
	});

	it("keeps every keyed tip's key text out of the rendered body when the binding is unbound", () => {
		const unbound = () => "";

		for (const tip of TIP_DEFINITIONS.filter((definition) => definition.bindings.length > 0)) {
			const body = tip.render(unbound);

			expect(body, tip.id).not.toContain("  .");
		}
	});
});

describe("command-gated tips", () => {
	const gated = TIP_DEFINITIONS.filter((tip) => tip.requiresCommand !== undefined);

	it("gates the extension-provided command tips", () => {
		expect(gated.length).toBeGreaterThan(0);
	});

	it("never selects a gated tip when its command is missing", () => {
		const selected = selectTip(gated, {}, 1_000, { keys: liveKeys, hasCommand: () => false });

		expect(selected).toBeUndefined();
	});

	it("selects a gated tip once its command is registered", () => {
		const target = gated[0];
		const selected = selectTip(gated, {}, 1_000, {
			keys: liveKeys,
			hasCommand: (command) => command === target.requiresCommand,
		});

		expect(selected?.id).toBe(target.id);
	});

	it("ignores the gate when no command resolver is injected", () => {
		const selected = selectTip(gated, {}, 1_000, { keys: liveKeys });

		expect(selected?.id).toBe(gated[0].id);
	});
});
