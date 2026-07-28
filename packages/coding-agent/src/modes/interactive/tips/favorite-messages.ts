import { keyText } from "../components/keybinding-hints.ts";

export type FavoriteCycleStatusKind = "empty" | "single";

export function buildFavoriteCycleStatusMessage(kind: FavoriteCycleStatusKind): string {
	const openSelector = keyText("app.model.select");
	const toggleFavorite = keyText("app.models.toggleFavorite");
	const setupHint = `Press ${openSelector} then ${toggleFavorite} to favorite models, or run /favorite-models.`;

	if (kind === "single") {
		return `Only one favorite model available. ${setupHint}`;
	}
	return `No favorite models configured. ${setupHint} See /help for the full reference.`;
}
