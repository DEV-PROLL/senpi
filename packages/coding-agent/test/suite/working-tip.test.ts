import { describe, expect, it } from "vitest";
import type { Keybinding } from "../../src/core/keybindings.ts";
import type { TipDefinition } from "../../src/modes/interactive/tips/registry.ts";
import { resolveWorkingTipLine } from "../../src/modes/interactive/tips/working-tip.ts";

const fakeKeys = (binding: Keybinding): string => `<<${binding}>>`;

const definitions: readonly TipDefinition[] = [
	{ id: "banner-tip", bindings: [], render: () => "Shown in the banner already." },
	{ id: "working-tip", bindings: [], render: () => "Shown while the agent works." },
];

describe("resolveWorkingTipLine", () => {
	it("returns a tip line while tips are enabled", () => {
		const resolved = resolveWorkingTipLine({
			tipsEnabled: true,
			history: {},
			sessionShownTipIds: new Set<string>(),
			now: 1_000,
			definitions,
			keys: fakeKeys,
		});

		expect(resolved).toBeDefined();
		expect(resolved?.line).toContain("Tip:");
	});

	it("returns undefined when tips are disabled", () => {
		expect(
			resolveWorkingTipLine({
				tipsEnabled: false,
				history: {},
				sessionShownTipIds: new Set<string>(),
				now: 1_000,
				definitions,
				keys: fakeKeys,
			}),
		).toBeUndefined();
	});

	it("never repeats a tip already shown this session, so the banner tip is excluded", () => {
		const resolved = resolveWorkingTipLine({
			tipsEnabled: true,
			history: {},
			sessionShownTipIds: new Set(["banner-tip"]),
			now: 1_000,
			definitions,
			keys: fakeKeys,
		});

		expect(resolved?.tipId).toBe("working-tip");
	});

	it("returns undefined when every tip was already shown this session", () => {
		expect(
			resolveWorkingTipLine({
				tipsEnabled: true,
				history: {},
				sessionShownTipIds: new Set(["banner-tip", "working-tip"]),
				now: 1_000,
				definitions,
				keys: fakeKeys,
			}),
		).toBeUndefined();
	});

	it("is stable across repeated calls within one turn given the same inputs", () => {
		const args = {
			tipsEnabled: true,
			history: {},
			sessionShownTipIds: new Set<string>(),
			now: 1_000,
			definitions,
			keys: fakeKeys,
		};

		expect(resolveWorkingTipLine(args)?.tipId).toBe(resolveWorkingTipLine(args)?.tipId);
	});

	it("emits exactly one line so the status area never grows by more than one row", () => {
		const resolved = resolveWorkingTipLine({
			tipsEnabled: true,
			history: {},
			sessionShownTipIds: new Set<string>(),
			now: 1_000,
			definitions,
			keys: fakeKeys,
		});

		expect(resolved?.line.split("\n")).toHaveLength(1);
	});
});
