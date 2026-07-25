import type { Api, Model } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness } from "../harness.ts";

function createModelRuntime(availableModels: Model<Api>[]) {
	return {
		getAvailableSnapshot: () => availableModels,
		refresh: vi.fn().mockResolvedValue({ aborted: false, errors: new Map() }),
		getModel: (provider: string, id: string) =>
			availableModels.find((model) => model.provider === provider && model.id === id),
		getError: () => undefined,
	};
}

function createSelector(options: { availableModels: Model<Api>[]; scopedModels: Array<{ model: Model<Api> }> }) {
	return new ModelSelectorComponent(
		{ requestRender: vi.fn() },
		undefined,
		{ setDefaultModelAndProvider: vi.fn() } as never,
		createModelRuntime(options.availableModels) as never,
		options.scopedModels,
		vi.fn(),
		vi.fn(),
	);
}

describe("issue #6949 unavailable scoped models", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("shows a scoped model without a catalog entry", async () => {
		const harness = await createHarness({ models: [{ id: "available", name: "Available" }] });
		try {
			const unavailableModel = {
				...harness.models[0],
				id: "unavailable",
				name: "Unavailable",
			};
			const selector = createSelector({
				availableModels: [...harness.models],
				scopedModels: [{ model: unavailableModel }],
			});

			expect(stripAnsi(selector.render(100).join("\n"))).toContain("unavailable [unavailable] ✗");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps available scoped models visible alongside unavailable entries", async () => {
		const harness = await createHarness({
			models: [
				{ id: "one", name: "One" },
				{ id: "two", name: "Two" },
			],
		});
		try {
			const unavailableModel = {
				...harness.models[0],
				id: "three",
				name: "Three",
			};
			const selector = createSelector({
				availableModels: [...harness.models],
				scopedModels: [{ model: harness.models[0] }, { model: unavailableModel }, { model: harness.models[1] }],
			});
			const rendered = stripAnsi(selector.render(100).join("\n"));

			expect(rendered).toContain("one [faux]");
			expect(rendered).toContain("three [unavailable] ✗");
			expect(rendered).toContain("two [faux]");
		} finally {
			harness.cleanup();
		}
	});
});
