import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type KeybindingsConfig, KeybindingsManager } from "../../src/core/keybindings.ts";
import { buildFavoriteCycleStatusMessage } from "../../src/modes/interactive/tips/favorite-messages.ts";

function withKeybindings<T>(userBindings: KeybindingsConfig, run: () => T): T {
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager(userBindings));
	try {
		return run();
	} finally {
		setKeybindings(previous);
	}
}

describe("buildFavoriteCycleStatusMessage", () => {
	it("tells the user how to configure favorites when none are set", () => {
		const message = buildFavoriteCycleStatusMessage("empty");

		expect(message).toContain("No favorite models configured");
		expect(message).toContain("/favorite-models");
		expect(message).toContain("/help");
	});

	it("keeps the single-favorite message and appends the toggle hint", () => {
		const message = buildFavoriteCycleStatusMessage("single");

		expect(message).toContain("Only one favorite model available");
		expect(message).toContain("/favorite-models");
	});

	it("renders the model-selector and favorite-toggle keys live, not hardcoded defaults", () => {
		const remapped = withKeybindings({ "app.model.select": "ctrl+y", "app.models.toggleFavorite": "ctrl+u" }, () =>
			buildFavoriteCycleStatusMessage("empty"),
		);

		expect(remapped).toContain("ctrl+y");
		expect(remapped).toContain("ctrl+u");
		expect(remapped).not.toContain("ctrl+l");
		expect(remapped).not.toContain("ctrl+f");
	});

	it("uses the default keys when no remap is configured", () => {
		const defaults = withKeybindings({}, () => buildFavoriteCycleStatusMessage("empty"));

		expect(defaults).toContain("ctrl+l");
		expect(defaults).toContain("ctrl+f");
	});
});
