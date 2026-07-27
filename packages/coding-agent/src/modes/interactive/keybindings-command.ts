import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { KeybindingsManager } from "../../core/keybindings.ts";

export type KeybindingsEditResult = { status: "reloaded" } | { status: "invalid"; message: string };

export function seedKeybindingsFile(configPath: string, keybindings: KeybindingsManager): boolean {
	if (existsSync(configPath)) return false;

	const tempPath = `${configPath}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(keybindings.getEffectiveConfig(), null, 2)}\n`, "utf-8");
	renameSync(tempPath, configPath);
	return true;
}

export function applyKeybindingsFileEdit(configPath: string, keybindings: KeybindingsManager): KeybindingsEditResult {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch (error) {
		return { status: "invalid", message: error instanceof Error ? error.message : String(error) };
	}

	try {
		JSON.parse(raw);
	} catch (error) {
		return { status: "invalid", message: error instanceof Error ? error.message : String(error) };
	}

	keybindings.reload();
	return { status: "reloaded" };
}
