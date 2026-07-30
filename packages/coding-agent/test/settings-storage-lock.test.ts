import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSettingsStorage, getSettingsPath } from "../src/core/settings-manager.ts";

const lockState = vi.hoisted(() => ({ onNextAcquire: undefined as (() => void) | undefined }));

vi.mock("proper-lockfile", async (importOriginal) => {
	const actual = await importOriginal<{ default: typeof import("proper-lockfile") }>();
	const base = actual.default;
	return {
		default: {
			...base,
			lockSync: (path: string, options?: Parameters<typeof base.lockSync>[1]) => {
				const hook = lockState.onNextAcquire;
				lockState.onNextAcquire = undefined;
				hook?.();
				return base.lockSync(path, options);
			},
		},
	};
});

describe("FileSettingsStorage.withLock", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;
	let settingsPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "senpi-lock-test-"));
		agentDir = join(root, "agent");
		cwd = join(root, "work");
		lockState.onNextAcquire = undefined;
		settingsPath = getSettingsPath(cwd, agentDir, "global", root);
	});

	afterEach(() => {
		lockState.onNextAcquire = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	it("#given no settings file #when another process creates it before the write lock #then the merge sees the winner's content", () => {
		const storage = new FileSettingsStorage(cwd, agentDir, root);
		lockState.onNextAcquire = () => {
			writeFileSync(settingsPath, JSON.stringify({ theme: "light" }), "utf-8");
		};

		storage.withLock("global", (current) => {
			const settings: Record<string, unknown> = current ? (JSON.parse(current) as Record<string, unknown>) : {};
			settings.defaultModel = "merged-model";
			return JSON.stringify(settings);
		});

		const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		expect(written.defaultModel).toBe("merged-model");
		expect(written.theme).toBe("light");
	});

	it("#given no settings file #when the callback only reads #then nothing is created", () => {
		const storage = new FileSettingsStorage(cwd, agentDir, root);
		let observed: string | undefined = "sentinel";

		storage.withLock("global", (current) => {
			observed = current;
			return undefined;
		});

		expect(observed).toBeUndefined();
		expect(existsSync(agentDir)).toBe(false);
		expect(existsSync(settingsPath)).toBe(false);
	});

	it("#given no settings file and no concurrent writer #when the callback writes #then the file is created with its output", () => {
		const storage = new FileSettingsStorage(cwd, agentDir, root);

		storage.withLock("global", () => JSON.stringify({ created: true }));

		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ created: true });
	});

	it("#given an existing settings file #when a writer mutates it at lock acquisition #then the callback reads under the lock", () => {
		const storage = new FileSettingsStorage(cwd, agentDir, root);
		storage.withLock("global", () => JSON.stringify({ x: 1 }));
		lockState.onNextAcquire = () => {
			writeFileSync(settingsPath, JSON.stringify({ x: 2 }), "utf-8");
		};

		storage.withLock("global", (current) => {
			const settings: Record<string, unknown> = current ? (JSON.parse(current) as Record<string, unknown>) : {};
			settings.y = true;
			return JSON.stringify(settings);
		});

		const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		expect(written.x).toBe(2);
		expect(written.y).toBe(true);
	});
});
