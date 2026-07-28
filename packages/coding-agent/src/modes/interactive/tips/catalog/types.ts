import type { Keybinding } from "../../../../core/keybindings.ts";

export interface TipDefinition {
	id: string;
	bindings: readonly Keybinding[];
	requiresCommand?: string;
	render(keys: (binding: Keybinding) => string): string;
}
