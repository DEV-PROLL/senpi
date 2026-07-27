import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import type { KeybindingsManager } from "../../core/keybindings.ts";

export type KeybindingsEditResult = { status: "reloaded" } | { status: "invalid"; message: string };

export function seedKeybindingsFile(configPath: string, keybindings: KeybindingsManager): boolean {
	let fd: number;
	try {
		// Exclusive create: fails with EEXIST if the file already exists, so a
		// concurrently created config is never overwritten (no check-then-create window).
		fd = openSync(configPath, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try {
		writeSync(fd, `${JSON.stringify(keybindings.getEffectiveConfig(), null, 2)}\n`);
	} finally {
		closeSync(fd);
	}
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
