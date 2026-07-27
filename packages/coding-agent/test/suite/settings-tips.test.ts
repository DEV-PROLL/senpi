import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { createConfigReloadLogger } from "../../src/core/extensions/builtin/config-reload/log.ts";
import {
	excludeRoutineOnlySettingsChanges,
	updateSettingsContentSnapshot,
} from "../../src/core/extensions/builtin/config-reload/routine-settings.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

const projectDirs: string[] = [];
const agentDir = getAgentDir();
const settingsPath = join(agentDir, "settings.json");

function createProjectDir(): string {
	const projectDir = mkdtempSync(join(tmpdir(), "senpi-settings-tips-"));
	projectDirs.push(projectDir);
	return projectDir;
}

function writeSettings(settings: unknown): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings)}\n`, "utf-8");
}

afterEach(() => {
	rmSync(settingsPath, { force: true });
	for (const projectDir of projectDirs.splice(0)) {
		rmSync(projectDir, { recursive: true, force: true });
	}
});

describe("SettingsManager tips settings", () => {
	it("enables tips by default and respects an explicit false", () => {
		expect(SettingsManager.inMemory().getTipsEnabled()).toBe(true);
		expect(SettingsManager.inMemory({ tips: false }).getTipsEnabled()).toBe(false);
	});

	it("round-trips and persists tips history in the quarantined agent directory", async () => {
		const manager = SettingsManager.create(createProjectDir());
		const history = {
			"welcome-tip": 1_700_000_000_000,
			"shortcut-tip": 1_700_000_100_000,
		};

		manager.setTipsHistory(history);
		expect(manager.getTipsHistory()).toEqual(history);
		await manager.flush();

		const persisted = JSON.parse(readFileSync(settingsPath, "utf-8")) as { tipsHistory?: unknown };
		expect(persisted.tipsHistory).toEqual(history);
	});

	it("falls back to an empty history for malformed persisted values", () => {
		const projectDir = createProjectDir();
		const malformedValues: readonly unknown[] = ["not-a-history", [], null];

		for (const tipsHistory of malformedValues) {
			writeSettings({ tipsHistory });
			expect(SettingsManager.create(projectDir).getTipsHistory()).toEqual({});
		}
	});

	it("suppresses tips-history-only settings changes but not non-routine changes", () => {
		const projectDir = createProjectDir();
		const logger = createConfigReloadLogger(agentDir);
		const snapshots = new Map<string, string>();
		writeSettings({ theme: "dark", tipsHistory: { "welcome-tip": 1_700_000_000_000 } });
		updateSettingsContentSnapshot(snapshots, settingsPath);

		writeSettings({ theme: "dark", tipsHistory: { "welcome-tip": 1_700_000_100_000 } });
		expect(excludeRoutineOnlySettingsChanges([settingsPath], snapshots, agentDir, projectDir, logger)).toEqual([]);

		writeSettings({ theme: "light", tipsHistory: { "welcome-tip": 1_700_000_100_000 } });
		expect(excludeRoutineOnlySettingsChanges([settingsPath], snapshots, agentDir, projectDir, logger)).toEqual([
			settingsPath,
		]);
	});
});
