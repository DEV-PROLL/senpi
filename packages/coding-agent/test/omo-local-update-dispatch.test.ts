// BETA(omo-local-update): background-dispatch coverage - delete with
// src/beta/omo-local-update*.ts and the other test/omo-local-update* files.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { omoLocalUpdateLockPath, readStamp, runOmoLocalUpdateBeta } from "../src/beta/omo-local-update.ts";
import type {
	OmoLocalSpawnWorker,
	OmoLocalWorkerSpawnOutcome,
	OmoLocalWorkerSpawnRequest,
} from "../src/beta/omo-local-update-worker.ts";
import { createOmoFixture, type OmoFixture } from "./omo-local-update-fixture.ts";
import {
	applyOmoGitIsolation,
	createTempRoots,
	installFakeBun,
	makeAgentDir,
	makeLogCollector,
	makeSpyRun,
	withPrependedPath,
} from "./omo-local-update-helpers.ts";

const gitIsolation = applyOmoGitIsolation();
const tempRoots = createTempRoots();
const makeTempRoot = tempRoots.makeTempRoot;

afterAll(() => {
	tempRoots.cleanup();
	gitIsolation.cleanup();
});

function makeSpySpawn(outcome?: OmoLocalWorkerSpawnOutcome): {
	requests: OmoLocalWorkerSpawnRequest[];
	spawnWorker: OmoLocalSpawnWorker;
} {
	const requests: OmoLocalWorkerSpawnRequest[] = [];
	return {
		requests,
		spawnWorker: (request) => {
			requests.push(request);
			return outcome ?? { ok: true, pid: 4242, logPath: "/tmp/fake-omo-worker.log" };
		},
	};
}

interface DispatchSetup {
	fixture: OmoFixture;
	agentDir: string;
	restorePath: () => void;
}

function setupDispatchFixture(root: string): DispatchSetup {
	const fixture = createOmoFixture(root);
	const agentDir = makeAgentDir(root);
	const binDir = join(root, "bin");
	installFakeBun(binDir);
	return { fixture, agentDir, restorePath: withPrependedPath(binDir) };
}

describe("runOmoLocalUpdateBeta dispatch mode", () => {
	it("hands a needed rebuild to the worker spawn instead of building inline", { timeout: 90000 }, async () => {
		const { fixture, agentDir, restorePath } = setupDispatchFixture(makeTempRoot());
		const { calls, run } = makeSpyRun();
		const { requests, spawnWorker } = makeSpySpawn();
		const { lines, log } = makeLogCollector();
		try {
			await runOmoLocalUpdateBeta({
				env: {},
				agentDir,
				settings: { packages: [fixture.pluginPath] },
				mode: "dispatch",
				spawnWorker,
				run,
				log,
			});
		} finally {
			restorePath();
		}
		expect(requests).toEqual([{ agentDir, force: false }]);
		expect(calls.some(([command]) => command === "bun")).toBe(false);
		expect(calls.some(([, ...args]) => args.includes("worktree"))).toBe(false);
		expect(lines.some((line) => line.includes("in background") && line.includes("/tmp/fake-omo-worker.log"))).toBe(
			true,
		);
		expect(lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(false);
		expect(readStamp(agentDir)).toBeUndefined();
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(false);
	});

	it("skips without spawning when the stamp already matches", { timeout: 90000 }, async () => {
		const { fixture, agentDir, restorePath } = setupDispatchFixture(makeTempRoot());
		const base = { env: {}, agentDir, settings: { packages: [fixture.pluginPath] } };
		const { requests, spawnWorker } = makeSpySpawn();
		const { lines, log } = makeLogCollector();
		try {
			const first = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, log: first.log });
			expect(first.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
			await runOmoLocalUpdateBeta({ ...base, mode: "dispatch", spawnWorker, log });
		} finally {
			restorePath();
		}
		expect(requests).toEqual([]);
		expect(lines.some((line) => line.includes("skipping rebuild"))).toBe(true);
	});

	it("propagates force to the worker even when the stamp matches", { timeout: 90000 }, async () => {
		const { fixture, agentDir, restorePath } = setupDispatchFixture(makeTempRoot());
		const base = { env: {}, agentDir, settings: { packages: [fixture.pluginPath] } };
		const { requests, spawnWorker } = makeSpySpawn();
		try {
			const first = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, log: first.log });
			const second = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, mode: "dispatch", force: true, spawnWorker, log: second.log });
		} finally {
			restorePath();
		}
		expect(requests).toEqual([{ agentDir, force: true }]);
	});

	it("degrades to a yellow warning when the worker spawn fails", { timeout: 90000 }, async () => {
		const { fixture, agentDir, restorePath } = setupDispatchFixture(makeTempRoot());
		const { requests, spawnWorker } = makeSpySpawn({ ok: false, message: "spawn boom" });
		const { lines, log } = makeLogCollector();
		try {
			await expect(
				runOmoLocalUpdateBeta({
					env: {},
					agentDir,
					settings: { packages: [fixture.pluginPath] },
					mode: "dispatch",
					spawnWorker,
					log,
				}),
			).resolves.toBeUndefined();
		} finally {
			restorePath();
		}
		expect(requests).toHaveLength(1);
		expect(lines.some((line) => line.includes("spawn boom"))).toBe(true);
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(false);
	});

	it("builds inline under SENPI_OMO_LOCAL_UPDATE_SYNC=1 even in dispatch mode", { timeout: 90000 }, async () => {
		const { fixture, agentDir, restorePath } = setupDispatchFixture(makeTempRoot());
		const { requests, spawnWorker } = makeSpySpawn();
		const { lines, log } = makeLogCollector();
		try {
			await runOmoLocalUpdateBeta({
				env: { SENPI_OMO_LOCAL_UPDATE_SYNC: "1" },
				agentDir,
				settings: { packages: [fixture.pluginPath] },
				mode: "dispatch",
				spawnWorker,
				log,
			});
		} finally {
			restorePath();
		}
		expect(requests).toEqual([]);
		expect(lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
		expect(readStamp(agentDir)).toBeDefined();
	});
});
