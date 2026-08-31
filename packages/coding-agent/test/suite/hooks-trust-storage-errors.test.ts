import * as actualFs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const injectedFailures = vi.hoisted(() => ({
	cleanup: undefined as Error | undefined,
	publication: undefined as Error | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return {
		...original,
		renameSync: (...args: Parameters<typeof original.renameSync>) => {
			if (injectedFailures.publication !== undefined) {
				throw injectedFailures.publication;
			}
			return original.renameSync(...args);
		},
		rmSync: (...args: Parameters<typeof original.rmSync>) => {
			if (injectedFailures.cleanup !== undefined) {
				throw injectedFailures.cleanup;
			}
			return original.rmSync(...args);
		},
	};
});

import { FileHookStateStorage } from "../../src/core/extensions/builtin/hooks/trust-storage.ts";

const createdDirs: string[] = [];

afterEach(async () => {
	injectedFailures.publication = undefined;
	injectedFailures.cleanup = undefined;
	for (const dir of createdDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("builtin hooks trust storage failures", () => {
	it("preserves publication and cleanup failures in order", async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), "senpi-hooks-trust-errors-"));
		createdDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		actualFs.mkdirSync(cwd, { recursive: true });
		const storage = new FileHookStateStorage({ agentDir, cwd });
		const publicationError = new Error("injected publication failure");
		const cleanupError = new Error("injected cleanup failure");
		injectedFailures.publication = publicationError;
		injectedFailures.cleanup = cleanupError;

		// When
		let thrown: unknown;
		try {
			storage.update("global", (current) => current);
		} catch (error) {
			thrown = error;
		}

		// Then
		expect(thrown).toBeInstanceOf(AggregateError);
		expect(thrown).toMatchObject({
			message: "Failed to publish and clean up hook trust state snapshot",
			errors: [publicationError, cleanupError],
		});
	});

	it("preserves the original publication error when cleanup succeeds", async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), "senpi-hooks-trust-errors-"));
		createdDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		actualFs.mkdirSync(cwd, { recursive: true });
		const storage = new FileHookStateStorage({ agentDir, cwd });
		const publicationError = new Error("injected publication failure");
		injectedFailures.publication = publicationError;

		// When
		let thrown: unknown;
		try {
			storage.update("global", (current) => current);
		} catch (error) {
			thrown = error;
		}

		// Then
		expect(thrown).toBe(publicationError);
	});
});
