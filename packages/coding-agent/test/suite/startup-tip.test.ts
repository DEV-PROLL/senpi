import { describe, expect, it } from "vitest";
import type { Keybinding } from "../../src/core/keybindings.ts";
import type { TipDefinition } from "../../src/modes/interactive/tips/registry.ts";
import { resolveStartupTipLine } from "../../src/modes/interactive/tips/startup-tip.ts";

const fakeKeys = (binding: Keybinding): string => `<<${binding}>>`;

const definitions: readonly TipDefinition[] = [
	{ id: "first", bindings: [], render: () => "First tip body." },
	{
		id: "second",
		bindings: ["app.thinking.cycle"],
		render: (keys) => `Second uses ${keys("app.thinking.cycle")}.`,
	},
];

describe("resolveStartupTipLine", () => {
	it("returns a rendered tip line and its id when tips are enabled and startup is not quiet", () => {
		const resolved = resolveStartupTipLine({
			tipsEnabled: true,
			quietStartup: false,
			history: {},
			now: 1_000,
			definitions,
			keys: fakeKeys,
		});

		expect(resolved).toBeDefined();
		expect(resolved?.tipId).toBe("first");
		expect(resolved?.line).toContain("First tip body.");
		expect(resolved?.line).toContain("Tip:");
	});

	it("renders keys through the injected resolver rather than hardcoded defaults", () => {
		const resolved = resolveStartupTipLine({
			tipsEnabled: true,
			quietStartup: false,
			history: { first: 500 },
			now: 1_000,
			definitions,
			keys: fakeKeys,
		});

		expect(resolved?.tipId).toBe("second");
		expect(resolved?.line).toContain("<<app.thinking.cycle>>");
		expect(resolved?.line).not.toContain("shift+tab");
	});

	it("returns undefined when tips are disabled", () => {
		expect(
			resolveStartupTipLine({
				tipsEnabled: false,
				quietStartup: false,
				history: {},
				now: 1_000,
				definitions,
				keys: fakeKeys,
			}),
		).toBeUndefined();
	});

	it("returns undefined when quiet startup is active", () => {
		expect(
			resolveStartupTipLine({
				tipsEnabled: true,
				quietStartup: true,
				history: {},
				now: 1_000,
				definitions,
				keys: fakeKeys,
			}),
		).toBeUndefined();
	});

	it("returns undefined when every definition is already excluded", () => {
		expect(
			resolveStartupTipLine({
				tipsEnabled: true,
				quietStartup: false,
				history: {},
				now: 1_000,
				definitions,
				keys: fakeKeys,
				exclude: new Set(["first", "second"]),
			}),
		).toBeUndefined();
	});

	it("emits exactly two lines: the tip and the give-me-tips pointer below it", () => {
		const resolved = resolveStartupTipLine({
			tipsEnabled: true,
			quietStartup: false,
			history: {},
			now: 1_000,
			definitions,
			keys: fakeKeys,
		});

		expect(resolved?.line.split("\n")).toHaveLength(2);
	});

	it("points at the give-me-tips skill on a second line under the tip", () => {
		const resolved = resolveStartupTipLine({
			tipsEnabled: true,
			quietStartup: false,
			history: {},
			now: 1_000,
			definitions,
			keys: fakeKeys,
		});

		const lines = resolved?.line.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines?.[0]).toContain("Tip:");
		expect(lines?.[1]).toContain("give-me-tips");
	});
});
