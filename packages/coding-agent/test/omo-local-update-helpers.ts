/**
 * Shared helpers for the omo-local-update (v2) test files.
 *
 * Non-test helper module (no vitest imports): each test file owns its lifecycle
 * hooks and calls these factories/utilities directly. Delete together with
 * src/beta/omo-local-update*.ts and the other test/omo-local-update* files.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { defaultRun, type OmoLocalRun } from "../src/beta/omo-local-update.ts";
import { FIXTURE_PLUGIN_ARTIFACTS } from "./omo-local-update-fixture.ts";

/**
 * Git determinism: isolate every git invocation in the calling test file
 * (test-side AND engine-side through the inherited process.env) from ambient
 * host config. Call at module scope; run `cleanup` from `afterAll`.
 */
export function applyOmoGitIsolation(): { cleanup: () => void } {
	const gitConfigDir = mkdtempSync(join(tmpdir(), "omo-local-update-gitcfg-"));
	const emptyGitConfig = join(gitConfigDir, "config");
	writeFileSync(emptyGitConfig, "");
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
	process.env.GIT_AUTHOR_NAME = "senpi-test";
	process.env.GIT_AUTHOR_EMAIL = "senpi-test@example.com";
	process.env.GIT_COMMITTER_NAME = "senpi-test";
	process.env.GIT_COMMITTER_EMAIL = "senpi-test@example.com";
	return {
		cleanup: () => {
			rmSync(gitConfigDir, { recursive: true, force: true });
		},
	};
}

/** Per-file temp-root factory; run `cleanup` from `afterAll`. */
export function createTempRoots(): { makeTempRoot: () => string; cleanup: () => void } {
	const tempRoots: string[] = [];
	return {
		makeTempRoot: () => {
			const root = mkdtempSync(join(tmpdir(), "omo-local-update-test-"));
			tempRoots.push(root);
			return root;
		},
		cleanup: () => {
			for (const root of tempRoots) {
				rmSync(root, { recursive: true, force: true });
			}
		},
	};
}

export function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

export function makeLogCollector(): { lines: string[]; log: (message: string) => void } {
	const lines: string[] = [];
	return {
		lines,
		log: (message: string) => {
			lines.push(message);
		},
	};
}

export function makeSpyRun(): { calls: string[][]; run: OmoLocalRun } {
	const calls: string[][] = [];
	return {
		calls,
		run: (command, args, options) => {
			calls.push([command, ...args]);
			return defaultRun(command, args, options);
		},
	};
}

export function artifactMtimes(pluginPath: string): Record<string, number> {
	const mtimes: Record<string, number> = {};
	for (const artifact of FIXTURE_PLUGIN_ARTIFACTS) {
		mtimes[artifact] = statSync(join(pluginPath, artifact)).mtimeMs;
	}
	return mtimes;
}

/**
 * Executable `bun` stand-in for orchestrator tests: `bun install` succeeds quietly;
 * `bun run build:senpi-plugin` runs the fixture's real stub build from the spawn cwd
 * (the updater's build worktree). FAKE_BUN_BUILD_FAIL makes the build exit 1 after
 * the stub wrote its artifacts into the worktree.
 */
export function installFakeBun(binDir: string): void {
	mkdirSync(binDir, { recursive: true });
	const script = [
		"#!/bin/sh",
		'if [ "$1" = "install" ]; then',
		'  echo "fake bun install: ok"',
		"  exit 0",
		"fi",
		'if [ "$1" = "run" ] && [ "$2" = "build:senpi-plugin" ]; then',
		"  node scripts/build-senpi-plugin.mjs",
		"  build_status=$?",
		'  if [ -n "$FAKE_BUN_BUILD_FAIL" ]; then',
		'    echo "fake bun: simulated build failure" >&2',
		"    exit 1",
		"  fi",
		"  exit $build_status",
		"fi",
		'echo "fake bun: unexpected argv: $*" >&2',
		"exit 1",
		"",
	].join("\n");
	const bunPath = join(binDir, "bun");
	writeFileSync(bunPath, script);
	chmodSync(bunPath, 0o755);
}

/** Prepend binDir to PATH; returns a restore function. */
export function withPrependedPath(binDir: string): () => void {
	const originalPath = process.env.PATH;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	return () => {
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
	};
}

export function makeAgentDir(root: string): string {
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	return agentDir;
}
