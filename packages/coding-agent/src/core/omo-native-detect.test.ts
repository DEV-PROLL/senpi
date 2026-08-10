import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectOmoNativeInstall } from "./omo-native-detect.ts";

// The omo-ai global install loads the plugin through the launcher's --extension flag, never through a
// settings.packages entry, so detection must also honor the launcher-set OMO_NATIVE env marker or the
// footer badge can never render for shipped installs.

const roots: string[] = [];

function omoRepoFixture(): { pluginPath: string } {
	const root = mkdtempSync(join(tmpdir(), "omo-detect-"));
	roots.push(root);
	const pluginPath = join(root, "packages", "omo-senpi", "plugin");
	mkdirSync(pluginPath, { recursive: true });
	writeFileSync(join(pluginPath, "package.json"), JSON.stringify({ name: "@code-yeongyu/omo-senpi" }));
	writeFileSync(
		join(root, "packages", "omo-senpi", "package.json"),
		JSON.stringify({ name: "@oh-my-opencode/omo-senpi" }),
	);
	mkdirSync(join(root, "packages", "senpi-task"), { recursive: true });
	writeFileSync(
		join(root, "packages", "senpi-task", "package.json"),
		JSON.stringify({ name: "@oh-my-opencode/senpi-task" }),
	);
	return { pluginPath };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("detectOmoNativeInstall", () => {
	describe("#given the launcher-set OMO_NATIVE env marker", () => {
		it("#when packages carry no omo entry #then detection still fires", () => {
			expect(detectOmoNativeInstall([], "/tmp/agent", { OMO_NATIVE: "1" })).toBe(true);
		});

		it("#when the marker holds any other value #then detection ignores it", () => {
			expect(detectOmoNativeInstall([], "/tmp/agent", { OMO_NATIVE: "0" })).toBe(false);
			expect(detectOmoNativeInstall([], "/tmp/agent", {})).toBe(false);
		});
	});

	describe("#given a settings.packages local-path omo plugin entry", () => {
		it("#when the repo gates all pass #then detection fires without the env marker", () => {
			const { pluginPath } = omoRepoFixture();
			expect(detectOmoNativeInstall([pluginPath], "/tmp/agent", {})).toBe(true);
		});
	});

	describe("#given neither the marker nor a matching package entry", () => {
		it("#when detection runs #then it stays false", () => {
			expect(detectOmoNativeInstall(undefined, "/tmp/agent", {})).toBe(false);
		});
	});
});
