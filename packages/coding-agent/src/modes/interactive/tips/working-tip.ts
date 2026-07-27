import type { Keybinding } from "../../../core/keybindings.ts";
import type { TipDefinition } from "./registry.ts";
import { selectTip } from "./scheduler.ts";

export interface WorkingTipOptions {
	tipsEnabled: boolean;
	history: Record<string, number>;
	sessionShownTipIds: ReadonlySet<string>;
	now: number;
	definitions: readonly TipDefinition[];
	keys: (binding: Keybinding) => string;
}

export interface WorkingTipLine {
	line: string;
	tipId: string;
}

export function resolveWorkingTipLine(options: WorkingTipOptions): WorkingTipLine | undefined {
	if (!options.tipsEnabled) return undefined;

	const tip = selectTip(options.definitions, options.history, options.now, {
		keys: options.keys,
		exclude: options.sessionShownTipIds,
	});
	if (!tip) return undefined;

	const body = tip.render(options.keys).replace(/\s*\n\s*/g, " ").trim();
	return { line: `Tip: ${body}`, tipId: tip.id };
}
