import { describe, expect, it } from "vitest";
import { KEYBINDINGS, type Keybinding } from "../../src/core/keybindings.ts";
import { recordTipShown } from "../../src/modes/interactive/tips/history-writer.ts";
import { TIP_DEFINITIONS, type TipDefinition } from "../../src/modes/interactive/tips/registry.ts";
import { selectTip } from "../../src/modes/interactive/tips/scheduler.ts";

function tip(id: string, bindings: readonly Keybinding[] = []): TipDefinition {
	return {
		id,
		bindings,
		render: (keys) => bindings.map(keys).join(" "),
	};
}

describe("selectTip", () => {
	it("prefers the first unseen eligible tip", () => {
		const definitions = [tip("seen-first"), tip("unseen-first"), tip("unseen-second")];
		const selected = selectTip(definitions, { "seen-first": 100 }, 200);

		expect(selected?.id).toBe("unseen-first");
	});

	it("selects the least recently shown tip when all eligible tips have history", () => {
		const definitions = [tip("newest"), tip("oldest"), tip("middle")];
		const selected = selectTip(definitions, { newest: 300, oldest: 100, middle: 200 }, 400);

		expect(selected?.id).toBe("oldest");
	});

	it("keeps selecting the only eligible tip", () => {
		const definitions = [tip("excluded"), tip("only")];
		const options = { exclude: new Set(["excluded"]) };

		expect(selectTip(definitions, {}, 100, options)?.id).toBe("only");
		expect(selectTip(definitions, { only: 100 }, 200, options)?.id).toBe("only");
	});

	it("returns undefined for an empty registry", () => {
		expect(selectTip([], {}, 100)).toBeUndefined();
	});

	it("ignores history ids absent from the registry and still prefers unseen tips", () => {
		const definitions = [tip("seen"), tip("unseen")];
		const selected = selectTip(definitions, { missing: 1, seen: 2 }, 100);

		expect(selected?.id).toBe("unseen");
	});

	it("skips excluded ids", () => {
		const definitions = [tip("first"), tip("second")];
		const selected = selectTip(definitions, {}, 100, { exclude: new Set(["first"]) });

		expect(selected?.id).toBe("second");
	});

	it("skips keyed tips only when every binding resolves to an empty string", () => {
		const hidden = tip("hidden", ["app.model.cycleForward", "app.model.cycleBackward"]);
		const partiallyBound = tip("partially-bound", ["app.model.cycleForward", "app.model.cycleBackward"]);
		const command = tip("command");
		const keys = (binding: Keybinding) => (binding === "app.model.cycleBackward" ? "Ctrl+P" : "");

		expect(selectTip([hidden, command], {}, 100, { keys: () => "" })?.id).toBe("command");
		expect(selectTip([partiallyBound, command], {}, 100, { keys })?.id).toBe("partially-bound");
		expect(selectTip([command], {}, 100, { keys: () => "" })?.id).toBe("command");
	});

	it("does not key-skip when no resolver is provided", () => {
		const hiddenWithoutResolver = tip("hidden-without-resolver", ["app.thinking.cycle"]);

		expect(selectTip([hiddenWithoutResolver, tip("command")], {}, 100)?.id).toBe("hidden-without-resolver");
	});

	it("breaks equal timestamp ties by definition order", () => {
		const definitions = [tip("first"), tip("second"), tip("third")];
		const selected = selectTip(definitions, { first: 100, second: 100, third: 100 }, 200);

		expect(selected?.id).toBe("first");
	});
});

describe("recordTipShown", () => {
	it("returns an updated history map", () => {
		expect(recordTipShown({ first: 100 }, "second", 200)).toEqual({ first: 100, second: 200 });
	});

	it("does not mutate its input and merges by tip id without clobbering other ids", () => {
		const history = { first: 100, second: 200 };
		const updated = recordTipShown(history, "first", 300);

		expect(updated).toEqual({ first: 300, second: 200 });
		expect(updated).not.toBe(history);
		expect(history).toEqual({ first: 100, second: 200 });
	});
});

describe("TIP_DEFINITIONS", () => {
	it("uses registered bindings and renders every declared binding through the injected resolver", () => {
		const keys = (binding: Keybinding) => `<<${binding}>>`;

		for (const definition of TIP_DEFINITIONS) {
			const rendered = definition.render(keys);
			for (const binding of definition.bindings) {
				expect(binding in KEYBINDINGS, `${definition.id}: ${binding}`).toBe(true);
				expect(rendered, definition.id).toContain(keys(binding));
			}
		}
	});
});
