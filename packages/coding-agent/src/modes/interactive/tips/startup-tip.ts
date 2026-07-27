import type { Keybinding } from "../../../core/keybindings.ts";
import type { TipDefinition } from "./registry.ts";
import { selectTip } from "./scheduler.ts";

export interface StartupTipOptions {
	tipsEnabled: boolean;
	quietStartup: boolean;
	history: Record<string, number>;
	now: number;
	definitions: readonly TipDefinition[];
	keys: (binding: Keybinding) => string;
	exclude?: ReadonlySet<string>;
}

export interface StartupTipLine {
	line: string;
	tipId: string;
}

export function resolveStartupTipLine(options: StartupTipOptions): StartupTipLine | undefined {
	if (!options.tipsEnabled) return undefined;
	if (options.quietStartup) return undefined;

	const selectOptions = options.exclude ? { keys: options.keys, exclude: options.exclude } : { keys: options.keys };
	const tip = selectTip(options.definitions, options.history, options.now, selectOptions);
	if (!tip) return undefined;

	const body = tip
		.render(options.keys)
		.replace(/\s*\n\s*/g, " ")
		.trim();
	return { line: `Tip: ${body}`, tipId: tip.id };
}
