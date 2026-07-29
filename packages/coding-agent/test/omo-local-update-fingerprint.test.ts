// BETA(omo-local-update): build-input fingerprint coverage - delete with
// src/beta/omo-local-update*.ts and the other test/omo-local-update* files.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { computeRemoteState, defaultRun, runOmoLocalUpdateBeta } from "../src/beta/omo-local-update.ts";
import { computeBuildInputsHashFromLsTree, isBuildInputRootPath } from "../src/beta/omo-local-update-fingerprint.ts";
import { advanceOriginDev, createOmoFixture } from "./omo-local-update-fixture.ts";
import {
	applyOmoGitIsolation,
	artifactMtimes,
	createTempRoots,
	git,
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

describe("build-input fingerprint", () => {
	it("classifies root paths by the exclusion list", () => {
		for (const excluded of ["docs", ".github", "README.md", "README.ko.md", "assets", "CHANGELOG.md", ".agents"]) {
			expect(isBuildInputRootPath(excluded)).toBe(false);
		}
		for (const included of [
			"packages",
			"script",
			"scripts",
			"package.json",
			"bun.lock",
			"postinstall.mjs",
			".gitmodules",
			"unknown-dir",
		]) {
			expect(isBuildInputRootPath(included)).toBe(true);
		}
	});

	it("hashes only included ls-tree entries", () => {
		const entry = (hash: string, name: string) => `100644 blob ${hash}\t${name}`;
		const base = [entry("aaa", "package.json"), entry("bbb", "docs")].join("\0");
		const docsMoved = [entry("aaa", "package.json"), entry("ccc", "docs")].join("\0");
		const inputMoved = [entry("ddd", "package.json"), entry("bbb", "docs")].join("\0");
		expect(computeBuildInputsHashFromLsTree(docsMoved)).toBe(computeBuildInputsHashFromLsTree(base));
		expect(computeBuildInputsHashFromLsTree(inputMoved)).not.toBe(computeBuildInputsHashFromLsTree(base));
	});

	it("keeps the remote fingerprint stable across docs-only commits and moves it for package commits", {
		timeout: 30000,
	}, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		const before = await computeRemoteState({ repoRoot: fixture.repoRoot, run: defaultRun });
		expect(before.buildInputsHash).toMatch(/^[0-9a-f]{64}$/);

		advanceOriginDev({ originDir: fixture.originDir, touch: "docs" });
		const afterDocs = await computeRemoteState({ repoRoot: fixture.repoRoot, run: defaultRun });
		expect(afterDocs.sha).not.toBe(before.sha);
		expect(afterDocs.buildInputsHash).toBe(before.buildInputsHash);

		advanceOriginDev({ originDir: fixture.originDir, touch: "omo-senpi" });
		const afterPackage = await computeRemoteState({ repoRoot: fixture.repoRoot, run: defaultRun });
		expect(afterPackage.buildInputsHash).not.toBe(afterDocs.buildInputsHash);
	});
});

describe("build-input fingerprint skip", () => {
	it("skips the rebuild when origin/dev moved without touching build inputs", { timeout: 90000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const base = { env: {}, agentDir, settings: { packages: [fixture.pluginPath] } };
		try {
			const first = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, log: first.log });
			expect(first.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
			const mtimesBefore = artifactMtimes(fixture.pluginPath);

			const newSha = advanceOriginDev({ originDir: fixture.originDir, touch: "docs" });
			const short = newSha.slice(0, 7);
			const { calls, run } = makeSpyRun();
			const second = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, run, log: second.log });

			expect(
				second.lines.some(
					(line) => line.includes(`@${short}`) && line.includes("(build inputs unchanged); skipping rebuild"),
				),
			).toBe(true);
			expect(second.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(false);
			expect(calls.some(([command]) => command === "bun")).toBe(false);
			expect(calls.some(([, ...args]) => args.includes("worktree"))).toBe(false);
			expect(calls.some(([, ...args]) => args.includes("checkout"))).toBe(false);
			expect(artifactMtimes(fixture.pluginPath)).toEqual(mtimesBefore);
		} finally {
			restorePath();
		}
	});

	it("still rebuilds when a root-level file outside the exclusion list changes", { timeout: 90000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const base = { env: {}, agentDir, settings: { packages: [fixture.pluginPath] } };
		try {
			const first = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, log: first.log });
			expect(first.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);

			advanceOriginDev({ originDir: fixture.originDir, touch: "other" });
			const { calls, run } = makeSpyRun();
			const second = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, run, log: second.log });

			expect(second.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
			expect(calls).toContainEqual(["bun", "install"]);
		} finally {
			restorePath();
		}
	});

	it("declines the skip when the stamp predates the fingerprint field", { timeout: 90000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const base = { env: {}, agentDir, settings: { packages: [fixture.pluginPath] } };
		try {
			const first = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, log: first.log });
			expect(first.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);

			const stampPath = join(agentDir, "omo-local-update-state.json");
			expect(existsSync(stampPath)).toBe(true);
			const parsedStamp: unknown = JSON.parse(readFileSync(stampPath, "utf-8"));
			if (typeof parsedStamp !== "object" || parsedStamp === null) {
				throw new Error("fixture stamp must be an object");
			}
			const withoutFingerprint: Record<string, unknown> = { ...parsedStamp };
			delete withoutFingerprint.buildInputsHash;
			rmSync(stampPath);
			writeFileSync(stampPath, JSON.stringify(withoutFingerprint));

			advanceOriginDev({ originDir: fixture.originDir, touch: "docs" });
			const { calls, run } = makeSpyRun();
			const second = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, run, log: second.log });

			expect(second.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
			expect(calls).toContainEqual(["bun", "install"]);
			expect(git(["rev-parse", "origin/dev"], fixture.repoRoot)).toBeTruthy();
		} finally {
			restorePath();
		}
	});
});
