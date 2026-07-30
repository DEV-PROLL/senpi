import type { Keybinding } from "../../../core/keybindings.ts";
import type { TipDefinition } from "./registry.ts";

export interface SelectTipOptions {
	exclude?: ReadonlySet<string>;
	keys?: (binding: Keybinding) => string;
	hasCommand?: (command: string) => boolean;
}

export function selectTip(
	definitions: readonly TipDefinition[],
	history: Record<string, number>,
	now: number,
	options: SelectTipOptions = {},
): TipDefinition | undefined {
	void now;
	const keys = options.keys;
	const hasCommand = options.hasCommand;
	let oldestTip: TipDefinition | undefined;
	let oldestTimestamp = Number.POSITIVE_INFINITY;

	for (const tip of definitions) {
		if (options.exclude?.has(tip.id)) continue;
		if (keys && tip.bindings.length > 0 && tip.bindings.every((binding) => keys(binding) === "")) continue;
		if (hasCommand && tip.requiresCommand !== undefined && !hasCommand(tip.requiresCommand)) continue;
		if (!Object.hasOwn(history, tip.id)) return tip;

		const lastShown = history[tip.id];
		if (oldestTip === undefined || lastShown < oldestTimestamp) {
			oldestTip = tip;
			oldestTimestamp = lastShown;
		}
	}

	return oldestTip;
}
