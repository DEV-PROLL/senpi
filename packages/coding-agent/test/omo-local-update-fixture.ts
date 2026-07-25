/**
 * Fake omo repo factory for omo-local-update tests and QA.
 *
 * Builds a fully local git fixture (bare origin + clone) under a caller-provided
 * tmpDir: the clone carries a stub `build:senpi-plugin` script that writes the
 * FULL artifact completeness set, the three omo package manifests with their
 * real names, and seed source files - all committed on `dev` and pushed.
 *
 * Determinism contract: no network, everything under the passed tmpDir, and
 * every git invocation runs with GIT_CONFIG_GLOBAL pointed at an empty file,
 * GIT_CONFIG_NOSYSTEM=1, and fixed GIT_AUTHOR_* / GIT_COMMITTER_* identity
 * and dates, so ambient host git config can never change an outcome.
 *
 * This is a non-test helper module: it stays dependency-free and must NOT
 * import src/beta/omo-local-update.ts.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface OmoFixture {
	/** Working clone of the fake omo repo (checked out on dev, tracking origin/dev). */
	repoRoot: string;
	/** Bare origin repository the clone pushes to and fetches from. */
	originDir: string;
	/** The local-path plugin dir a settings `packages` entry would point at. */
	pluginPath: string;
}

/** Artifact completeness set written by the stub build, relative to pluginPath. */
export const FIXTURE_PLUGIN_ARTIFACTS = [
	"extensions/omo.js",
	"runtime/lsp-daemon/dist/cli.js",
	"runtime/lsp-daemon/dist/index.js",
	"runtime/lsp-daemon/dist/.omo-runtime-manifest.json",
	"scripts/install.mjs",
	"skills/alpha/SKILL.md",
	"skills/beta/SKILL.md",
] as const;

const GENERATED_OMO_JS = "packages/omo-senpi/plugin/extensions/omo.js";
const SOURCE_INDEX_TS = "packages/omo-senpi/src/index.ts";

const BUILD_SCRIPT = `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginRoot = join(repoRoot, "packages", "omo-senpi", "plugin");
const artifacts = {
	"extensions/omo.js": "// omo extension bundle (fixture stub)\\nexport {};\\n",
	"runtime/lsp-daemon/dist/cli.js": "// lsp daemon cli (fixture stub)\\n",
	"runtime/lsp-daemon/dist/index.js": "// lsp daemon index (fixture stub)\\n",
	"runtime/lsp-daemon/dist/.omo-runtime-manifest.json": JSON.stringify({ fixture: true, schema: 1 }) + "\\n",
	"scripts/install.mjs": "// install script (fixture stub)\\n",
	"skills/alpha/SKILL.md": "# alpha skill (fixture stub)\\n",
	"skills/beta/SKILL.md": "# beta skill (fixture stub)\\n",
};
for (const [relativePath, content] of Object.entries(artifacts)) {
	const target = join(pluginRoot, relativePath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}
console.log("fixture build:senpi-plugin wrote " + Object.keys(artifacts).length + " artifacts");
`;

function gitDirFor(anchorDir: string): string {
	const dotGit = join(anchorDir, ".git");
	return existsSync(dotGit) ? dotGit : anchorDir;
}

function ensureConfig(anchorDir: string): string {
	const configPath = join(gitDirFor(anchorDir), "fixture-gitconfig");
	if (!existsSync(configPath)) writeFileSync(configPath, "");
	return configPath;
}

function gitEnv(configPath: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_CONFIG_GLOBAL: configPath,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "OMO Fixture",
		GIT_AUTHOR_EMAIL: "omo-fixture@example.invalid",
		GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
		GIT_COMMITTER_NAME: "OMO Fixture",
		GIT_COMMITTER_EMAIL: "omo-fixture@example.invalid",
		GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
	};
}

/**
 * Environment for git invocations against a fixture repo, honoring the
 * determinism contract. `anchorDir` is a fixture repoRoot or originDir.
 * Exported so tests can run their own git assertions under the same isolation.
 */
export function fixtureGitEnv(anchorDir: string): NodeJS.ProcessEnv {
	return gitEnv(ensureConfig(anchorDir));
}

function runGit(args: string[], cwd: string, configPath: string): string {
	return execFileSync("git", args, {
		cwd,
		env: gitEnv(configPath),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function writeSeedFile(repoRoot: string, relativePath: string, content: string): void {
	const target = join(repoRoot, relativePath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function writeSeedJson(repoRoot: string, relativePath: string, value: Record<string, unknown>): void {
	writeSeedFile(repoRoot, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Build the fake omo repo: bare origin + clone, stub build writing the full
 * artifact completeness set, all three omo package manifests, committed on
 * `dev` and pushed, origin URL set to the local bare path.
 */
export function createOmoFixture(tmpDir: string): OmoFixture {
	mkdirSync(tmpDir, { recursive: true });
	const originDir = join(tmpDir, "origin.git");
	const repoRoot = join(tmpDir, "repo");
	const pluginPath = join(repoRoot, "packages", "omo-senpi", "plugin");
	const configPath = join(tmpDir, "fixture-gitconfig");
	writeFileSync(configPath, "");

	runGit(["init", "--bare", "-b", "dev", originDir], tmpDir, configPath);
	runGit(["clone", originDir, repoRoot], tmpDir, configPath);
	runGit(["symbolic-ref", "HEAD", "refs/heads/dev"], repoRoot, configPath);

	writeSeedJson(repoRoot, "package.json", {
		name: "omo-fixture",
		private: true,
		version: "0.0.0",
		scripts: { "build:senpi-plugin": "node scripts/build-senpi-plugin.mjs" },
	});
	writeSeedFile(repoRoot, "scripts/build-senpi-plugin.mjs", BUILD_SCRIPT);
	writeSeedFile(repoRoot, ".gitignore", "node_modules/\n");
	writeSeedJson(repoRoot, "packages/omo-senpi/package.json", {
		name: "@oh-my-opencode/omo-senpi",
		private: true,
		version: "0.0.0",
	});
	writeSeedJson(repoRoot, "packages/omo-senpi/plugin/package.json", {
		name: "@code-yeongyu/omo-senpi",
		private: true,
		version: "0.0.0",
	});
	writeSeedJson(repoRoot, "packages/senpi-task/package.json", {
		name: "@oh-my-opencode/senpi-task",
		private: true,
		version: "0.0.0",
	});
	writeSeedFile(repoRoot, SOURCE_INDEX_TS, "// omo-senpi fixture source\nexport {};\n");
	writeSeedFile(repoRoot, "packages/senpi-task/src/index.ts", "// senpi-task fixture source\nexport {};\n");

	// Run the stub build once so the generated artifacts are TRACKED (matching
	// the real omo checkout, where plugin/extensions/omo.js etc. are committed).
	execFileSync(process.execPath, [join(repoRoot, "scripts", "build-senpi-plugin.mjs")], {
		cwd: repoRoot,
		stdio: ["ignore", "pipe", "pipe"],
	});

	runGit(["add", "-A"], repoRoot, configPath);
	runGit(["commit", "-m", "fixture: seed fake omo repo"], repoRoot, configPath);
	runGit(["push", "-u", "origin", "dev"], repoRoot, configPath);
	runGit(["remote", "set-url", "origin", originDir], repoRoot, configPath);

	return { repoRoot, originDir, pluginPath };
}

/** Modify a tracked SOURCE-set file (outside every generated prefix). */
export function dirtySource(repoRoot: string): string {
	appendFileSync(join(repoRoot, SOURCE_INDEX_TS), "// fixture source dirt\n");
	return SOURCE_INDEX_TS;
}

/** Modify a tracked GENERATED-set file (under plugin/extensions/). */
export function dirtyGenerated(repoRoot: string): string {
	appendFileSync(join(repoRoot, GENERATED_OMO_JS), "// fixture generated dirt\n");
	return GENERATED_OMO_JS;
}

/**
 * `git mv` a generated file to a source path, producing a porcelain rename
 * whose halves straddle the GENERATED/SOURCE boundary.
 */
export function dirtyRenameAcrossSets(repoRoot: string): { from: string; to: string } {
	const from = "packages/omo-senpi/plugin/skills/alpha/SKILL.md";
	const to = "packages/omo-senpi/src/alpha-skill.md";
	runGit(["mv", from, to], repoRoot, ensureConfig(repoRoot));
	return { from, to };
}

function commitOnLocalDev(repoRoot: string, label: string): string {
	const configPath = ensureConfig(repoRoot);
	const n = Number(runGit(["rev-list", "--count", "HEAD"], repoRoot, configPath)) + 1;
	writeSeedFile(repoRoot, `local-dev-${n}.txt`, `${label} ${n}\n`);
	runGit(["add", "-A"], repoRoot, configPath);
	runGit(["commit", "-m", `${label} ${n}`], repoRoot, configPath);
	return runGit(["rev-parse", "HEAD"], repoRoot, configPath);
}

/**
 * Advance origin/dev by committing in a second temporary clone of the bare
 * origin. Returns the new origin/dev sha. The fixture clone is NOT fetched.
 */
export function advanceOriginDev(originDir: string): string {
	const configPath = ensureConfig(originDir);
	const n = Number(runGit(["rev-list", "--count", "dev"], originDir, configPath)) + 1;
	const workDir = join(dirname(originDir), "origin-advance-work");
	rmSync(workDir, { recursive: true, force: true });
	try {
		runGit(["clone", originDir, workDir], dirname(originDir), configPath);
		writeSeedFile(workDir, `origin-dev-${n}.txt`, `origin dev commit ${n}\n`);
		runGit(["add", "-A"], workDir, configPath);
		runGit(["commit", "-m", `origin dev commit ${n}`], workDir, configPath);
		runGit(["push", "origin", "dev"], workDir, configPath);
		return runGit(["rev-parse", "dev"], originDir, configPath);
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

/** Commit on the fixture's local dev WITHOUT pushing (local-only commit). */
export function advanceLocalDevOnly(repoRoot: string): string {
	return commitOnLocalDev(repoRoot, "local dev commit");
}

/**
 * Commit locally on dev without pushing AND advance origin/dev, leaving the
 * two diverged (one commit each side after the fixture fetches).
 */
export function divergeLocalDev(repoRoot: string): { localSha: string; originSha: string } {
	const configPath = ensureConfig(repoRoot);
	const localSha = commitOnLocalDev(repoRoot, "local dev commit");
	const originDir = runGit(["remote", "get-url", "origin"], repoRoot, configPath);
	const originSha = advanceOriginDev(originDir);
	runGit(["fetch", "origin", "dev"], repoRoot, configPath);
	return { localSha, originSha };
}

/** Check out a side branch and delete the local dev branch. */
export function deleteLocalDev(repoRoot: string): void {
	const configPath = ensureConfig(repoRoot);
	runGit(["checkout", "-B", "fixture-side"], repoRoot, configPath);
	runGit(["branch", "-D", "dev"], repoRoot, configPath);
}

/**
 * Install an executable pre-receive hook exiting 1 in the bare origin, so
 * pushes deterministically fail while fetches keep working.
 */
export function blockPushes(originDir: string): void {
	const hookPath = join(originDir, "hooks", "pre-receive");
	writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
	chmodSync(hookPath, 0o755);
}

/**
 * Install an executable pre-commit hook exiting 1 in the fixture clone, so
 * `git commit` deterministically fails (regardless of identity env).
 */
export function blockCommits(repoRoot: string): void {
	const hookPath = join(repoRoot, ".git", "hooks", "pre-commit");
	writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
	chmodSync(hookPath, 0o755);
}
