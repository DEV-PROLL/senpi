import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyGrokNeoThemeFallback, runGrokNeoFirstTimeSetup } from "../../src/main.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { getResolvedThemeColors, initTheme } from "../../src/modes/interactive/theme/theme.ts";

function activateTheme(settingsManager: SettingsManager): Record<string, string> {
	initTheme(settingsManager.getTheme());
	return getResolvedThemeColors();
}

describe("grok-neo theme precedence", () => {
	it("uses grok-night in memory for a fresh startup without writing a theme", () => {
		const settingsManager = SettingsManager.inMemory();
		applyGrokNeoThemeFallback(settingsManager);

		expect(settingsManager.getThemeSetting()).toBe("grok-night");
		expect(settingsManager.getGlobalSettings()).not.toHaveProperty("theme");
		expect(activateTheme(settingsManager)).toEqual(getResolvedThemeColors("grok-night"));
	});

	it("keeps an existing settings theme", () => {
		const settingsManager = SettingsManager.inMemory({ theme: "dark" });
		applyGrokNeoThemeFallback(settingsManager);

		expect(settingsManager.getThemeSetting()).toBe("dark");
		expect(activateTheme(settingsManager)).toEqual(getResolvedThemeColors("dark"));
	});

	it("keeps grok-day when settings explicitly select it", () => {
		const settingsManager = SettingsManager.inMemory({ theme: "grok-day" });
		applyGrokNeoThemeFallback(settingsManager);

		expect(settingsManager.getThemeSetting()).toBe("grok-day");
		expect(activateTheme(settingsManager)).toEqual(getResolvedThemeColors("grok-day"));
	});

	it("keeps a custom user theme selection", () => {
		const settingsManager = SettingsManager.inMemory({ theme: "my-custom-theme" });
		applyGrokNeoThemeFallback(settingsManager);

		expect(settingsManager.getThemeSetting()).toBe("my-custom-theme");
	});

	it("keeps an explicit session selection after settings reload", async () => {
		const settingsManager = SettingsManager.inMemory();
		applyGrokNeoThemeFallback(settingsManager);
		settingsManager.setTheme("grok-day");
		await settingsManager.flush();
		await settingsManager.reload();

		expect(settingsManager.getThemeSetting()).toBe("grok-day");
	});
});

describe("grok-neo first-time setup", () => {
	it("persists analytics but not a setup theme on a fresh grok run", async () => {
		const sandbox = mkdtempSync(join(tmpdir(), "senpi-grok-neo-setup-"));
		const agentDir = join(sandbox, "agent");
		const settingsManager = SettingsManager.create(join(sandbox, "work"), agentDir);
		try {
			await runGrokNeoFirstTimeSetup(settingsManager, async (manager) => {
				manager.setTheme("dark");
				manager.setEnableAnalytics(true);
				await manager.flush();
			});

			const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
			expect(settings).not.toHaveProperty("theme");
			expect(settings).toMatchObject({ enableAnalytics: true });
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});
