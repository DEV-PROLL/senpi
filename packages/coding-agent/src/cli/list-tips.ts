/**
 * List the tip catalog as JSON
 */

import { type Keybinding, KeybindingsManager } from "../core/keybindings.ts";
import { TIP_DEFINITIONS } from "../modes/interactive/tips/registry.ts";

export interface ListedTip {
	id: string;
	text: string;
	requiresCommand?: string;
}

/**
 * Render every catalog tip with the default keybindings
 */
export function collectTips(): ListedTip[] {
	const keybindings = new KeybindingsManager();
	const keys = (binding: Keybinding): string => keybindings.getKeys(binding).join("/");

	return TIP_DEFINITIONS.map((tip) => {
		const text = tip.render(keys);
		if (tip.requiresCommand !== undefined) {
			return { id: tip.id, text, requiresCommand: tip.requiresCommand };
		}
		return { id: tip.id, text };
	});
}

/**
 * Print the tip catalog as a JSON array
 */
export function listTips(): void {
	console.log(JSON.stringify(collectTips(), null, 2));
}
