import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	classifyDirt,
	defaultRun,
	detectOmoLocalInstall,
	isKillSwitched,
	type OmoLocalRun,
	OmoLocalSyncError,
	type OmoLocalUpdateStamp,
	omoLocalUpdateLockPath,
	omoLocalUpdateStampPath,
	readStamp,
	runOmoLocalUpdateBeta,
	shouldSkipBuild,
	syncToOriginDev,
	writeStamp,
} from "../src/beta/omo-local-update.ts";
import {
	advanceLocalDevOnly,
	advanceOriginDev,
	blockCommits,
	blockPushes,
	createOmoFixture,
	deleteLocalDev,
	dirtyGenerated,
	dirtyRenameAcrossSets,
	dirtySource,
	divergeLocalDev,
	FIXTURE_PLUGIN_ARTIFACTS,
} from "./omo-local-update-fixture.ts";

// Git determinism: isolate every git invocation in this file (test-side AND
// engine-side through the inherited process.env) from ambient host config.
const gitConfigDir = mkdtempSync(join(tmpdir(), "omo-local-update-gitcfg-"));
const emptyGitConfig = join(gitConfigDir, "config");
writeFileSync(emptyGitConfig, "");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
process.env.GIT_AUTHOR_NAME = "senpi-test";
process.env.GIT_AUTHOR_EMAIL = "senpi-test@example.com";
process.env.GIT_COMMITTER_NAME = "senpi-test";
process.env.GIT_COMMITTER_EMAIL = "senpi-test@example.com";

const tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omo-local-update-test-"));
	tempRoots.push(root);
	return root;
}

afterAll(() => {
	for (const root of tempRoots) {
		rmSync(root, { recursive: true, force: true });
	}
	rmSync(gitConfigDir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

interface LayoutOptions {
	pluginPkgName?: string;
	withOmoSenpiWorkspace?: boolean;
	withSenpiTask?: boolean;
	gitInit?: boolean;
}

function makeOmoLayout(
	root: string,
	options: LayoutOptions = {},
): { repoRoot: string; pluginPath: string; agentDir: string } {
	const repoRoot = join(root, "omo");
	const pluginPath = join(repoRoot, "packages", "omo-senpi", "plugin");
	const agentDir = join(root, "agent");
	mkdirSync(pluginPath, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(pluginPath, "package.json"),
		JSON.stringify({ name: options.pluginPkgName ?? "@code-yeongyu/omo-senpi" }),
	);
	if (options.withOmoSenpiWorkspace ?? true) {
		writeFileSync(
			join(repoRoot, "packages", "omo-senpi", "package.json"),
			JSON.stringify({ name: "@oh-my-opencode/omo-senpi" }),
		);
	}
	if (options.withSenpiTask ?? true) {
		mkdirSync(join(repoRoot, "packages", "senpi-task"), { recursive: true });
		writeFileSync(
			join(repoRoot, "packages", "senpi-task", "package.json"),
			JSON.stringify({ name: "@oh-my-opencode/senpi-task" }),
		);
	}
	if (options.gitInit ?? true) {
		git(["-c", "init.defaultBranch=main", "init"], repoRoot);
	}
	return { repoRoot, pluginPath, agentDir };
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function expectPidDead(pid: number): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	}
	expect(pidAlive(pid)).toBe(false);
}

describe("isKillSwitched", () => {
	it("returns true only for the literal '0'", () => {
		expect(isKillSwitched({ SENPI_OMO_LOCAL_UPDATE: "0" })).toBe(true);
		expect(isKillSwitched({ SENPI_OMO_LOCAL_UPDATE: "1" })).toBe(false);
		expect(isKillSwitched({ SENPI_OMO_LOCAL_UPDATE: "" })).toBe(false);
		expect(isKillSwitched({})).toBe(false);
	});
});

describe("defaultRun process seam", () => {
	it("captures stdout and stderr and resolves the exit code", async () => {
		const result = await defaultRun(
			process.execPath,
			["-e", 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3);'],
			{},
		);
		expect(result.code).toBe(3);
		expect(result.stdout).toBe("out");
		expect(result.stderr).toBe("err");
		expect(result.timedOut).toBe(false);
	});

	it("merges options.env over process.env", async () => {
		process.env.OMO_LOCAL_UPDATE_SEAM_AMBIENT = "base";
		const result = await defaultRun(
			process.execPath,
			[
				"-e",
				"console.log(JSON.stringify({ injected: process.env.OMO_LOCAL_UPDATE_SEAM_TEST ?? null, overridden: process.env.OMO_LOCAL_UPDATE_SEAM_AMBIENT ?? null, hasPath: Boolean(process.env.PATH) }));",
			],
			{ env: { OMO_LOCAL_UPDATE_SEAM_TEST: "hello", OMO_LOCAL_UPDATE_SEAM_AMBIENT: "override" } },
		);
		const printed = JSON.parse(result.stdout.trim()) as {
			injected: string | null;
			overridden: string | null;
			hasPath: boolean;
		};
		expect(printed.injected).toBe("hello");
		expect(printed.overridden).toBe("override");
		expect(printed.hasPath).toBe(true);
	});

	it("kills the whole process tree and reports timedOut on timeout", async () => {
		const script = [
			'const { spawn } = require("node:child_process");',
			'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
			"console.log(JSON.stringify({ self: process.pid, grandchild: grandchild.pid }));",
			"setInterval(() => {}, 1000);",
		].join("\n");
		const result = await defaultRun(process.execPath, ["-e", script], { timeoutMs: 2000 });
		expect(result.timedOut).toBe(true);
		const pids = JSON.parse(result.stdout.trim()) as { self: number; grandchild: number };
		await expectPidDead(pids.self);
		await expectPidDead(pids.grandchild);
	});
});

describe("detectOmoLocalInstall", () => {
	it("returns undefined when the packages key is absent", async () => {
		const root = makeTempRoot();
		const { agentDir } = makeOmoLayout(root);
		expect(await detectOmoLocalInstall({ packages: undefined, agentDir, run: defaultRun })).toBeUndefined();
	});

	it("returns undefined for npm-only and git-only entries", async () => {
		const root = makeTempRoot();
		const { agentDir } = makeOmoLayout(root);
		expect(
			await detectOmoLocalInstall({
				packages: ["npm:@code-yeongyu/omo-senpi", "git:https://example.com/omo.git"],
				agentDir,
				run: defaultRun,
			}),
		).toBeUndefined();
	});

	it("returns undefined when the plugin package name does not match", async () => {
		const root = makeTempRoot();
		const { pluginPath, agentDir } = makeOmoLayout(root, { pluginPkgName: "@code-yeongyu/not-omo" });
		expect(await detectOmoLocalInstall({ packages: [pluginPath], agentDir, run: defaultRun })).toBeUndefined();
	});

	it("returns undefined when the senpi-task workspace package is missing", async () => {
		const root = makeTempRoot();
		const { pluginPath, agentDir } = makeOmoLayout(root, { withSenpiTask: false });
		expect(await detectOmoLocalInstall({ packages: [pluginPath], agentDir, run: defaultRun })).toBeUndefined();
	});

	it("returns undefined when the omo-senpi workspace package is missing", async () => {
		const root = makeTempRoot();
		const { pluginPath, agentDir } = makeOmoLayout(root, { withOmoSenpiWorkspace: false });
		expect(await detectOmoLocalInstall({ packages: [pluginPath], agentDir, run: defaultRun })).toBeUndefined();
	});

	it("returns undefined when the derived repo root is not a git repository", async () => {
		const root = makeTempRoot();
		const { pluginPath, agentDir } = makeOmoLayout(root, { gitInit: false });
		expect(await detectOmoLocalInstall({ packages: [pluginPath], agentDir, run: defaultRun })).toBeUndefined();
	});

	it("returns undefined when the git toplevel is an enclosing repository", async () => {
		const root = makeTempRoot();
		git(["-c", "init.defaultBranch=main", "init"], root);
		const { pluginPath, agentDir } = makeOmoLayout(root, { gitInit: false });
		expect(await detectOmoLocalInstall({ packages: [pluginPath], agentDir, run: defaultRun })).toBeUndefined();
	});

	it("resolves pluginPath and repoRoot for an absolute settings entry", async () => {
		const root = makeTempRoot();
		const { repoRoot, pluginPath, agentDir } = makeOmoLayout(root);
		const install = await detectOmoLocalInstall({ packages: [pluginPath], agentDir, run: defaultRun });
		expect(install).toEqual({ pluginPath: resolve(pluginPath), repoRoot: resolve(repoRoot) });
	});

	it("resolves a relative settings entry against agentDir", async () => {
		const root = makeTempRoot();
		const { repoRoot, pluginPath, agentDir } = makeOmoLayout(root);
		const relativeEntry = relative(agentDir, pluginPath);
		const install = await detectOmoLocalInstall({ packages: [relativeEntry], agentDir, run: defaultRun });
		expect(install).toEqual({ pluginPath: resolve(pluginPath), repoRoot: resolve(repoRoot) });
	});

	it("expands a ~-prefixed settings entry against the home directory", async () => {
		const root = makeTempRoot();
		const { repoRoot, pluginPath, agentDir } = makeOmoLayout(root);
		const originalHome = process.env.HOME;
		process.env.HOME = root;
		try {
			const install = await detectOmoLocalInstall({
				packages: ["~/omo/packages/omo-senpi/plugin"],
				agentDir,
				run: defaultRun,
			});
			expect(install).toEqual({ pluginPath: resolve(pluginPath), repoRoot: resolve(repoRoot) });
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});

	it("accepts object-form PackageSource entries", async () => {
		const root = makeTempRoot();
		const { repoRoot, pluginPath, agentDir } = makeOmoLayout(root);
		const install = await detectOmoLocalInstall({
			packages: [{ source: pluginPath, autoload: true }],
			agentDir,
			run: defaultRun,
		});
		expect(install).toEqual({ pluginPath: resolve(pluginPath), repoRoot: resolve(repoRoot) });
	});

	it("skips non-matching entries and finds a later matching one", async () => {
		const root = makeTempRoot();
		const { repoRoot, pluginPath, agentDir } = makeOmoLayout(root);
		const install = await detectOmoLocalInstall({
			packages: ["npm:@scope/other", join(root, "does-not-exist"), { source: pluginPath }],
			agentDir,
			run: defaultRun,
		});
		expect(install).toEqual({ pluginPath: resolve(pluginPath), repoRoot: resolve(repoRoot) });
	});

	it("honors injected readJson, exists and run seams", async () => {
		const pluginPath = join("/virtual", "omo", "packages", "omo-senpi", "plugin");
		const repoRoot = join("/virtual", "omo");
		const names = new Map<string, string>([
			[join(pluginPath, "package.json"), "@code-yeongyu/omo-senpi"],
			[join(repoRoot, "packages", "omo-senpi", "package.json"), "@oh-my-opencode/omo-senpi"],
			[join(repoRoot, "packages", "senpi-task", "package.json"), "@oh-my-opencode/senpi-task"],
		]);
		const install = await detectOmoLocalInstall({
			packages: [pluginPath],
			agentDir: "/virtual/agent",
			readJson: (path) => {
				const name = names.get(path);
				return name === undefined ? undefined : { name };
			},
			exists: (path) => names.has(path),
			run: async () => ({ code: 0, stdout: `${realpathSync("/")}virtual${"/"}omo\n`, stderr: "", timedOut: false }),
		});
		expect(install).toEqual({ pluginPath, repoRoot });
	});
});

describe("readStamp/writeStamp", () => {
	const stamp: OmoLocalUpdateStamp = {
		repoRoot: "/some/repo",
		builtSha: "0123456789abcdef",
		builtAt: "2026-07-25T00:00:00.000Z",
		artifacts: ["plugin/extensions/omo.js", "plugin/scripts/install.mjs"],
	};

	it("round-trips a stamp through the agent dir state file", () => {
		const agentDir = join(makeTempRoot(), "agent");
		writeStamp(agentDir, stamp);
		expect(readStamp(agentDir)).toEqual(stamp);
	});

	it("returns undefined when no stamp file exists", () => {
		const agentDir = join(makeTempRoot(), "agent");
		mkdirSync(agentDir, { recursive: true });
		expect(readStamp(agentDir)).toBeUndefined();
	});

	it("returns undefined for a corrupt stamp file", () => {
		const agentDir = join(makeTempRoot(), "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(omoLocalUpdateStampPath(agentDir), "{ not json");
		expect(readStamp(agentDir)).toBeUndefined();
	});

	it("returns undefined for a stamp with an invalid shape", () => {
		const agentDir = join(makeTempRoot(), "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			omoLocalUpdateStampPath(agentDir),
			JSON.stringify({ repoRoot: "/some/repo", builtSha: 42, builtAt: "now", artifacts: "nope" }),
		);
		expect(readStamp(agentDir)).toBeUndefined();
	});
});

describe("shouldSkipBuild", () => {
	const stamp: OmoLocalUpdateStamp = {
		repoRoot: "/repo",
		builtSha: "abc123",
		builtAt: "2026-07-25T00:00:00.000Z",
		artifacts: ["plugin/extensions/omo.js"],
	};
	const base = {
		stamp,
		repoRoot: "/repo",
		targetSha: "abc123",
		stampArtifactsExist: true,
		force: false,
	};

	it("skips when the stamp matches, the full inventory exists, and force is off", () => {
		expect(shouldSkipBuild(base)).toBe(true);
	});

	it("builds when force is set", () => {
		expect(shouldSkipBuild({ ...base, force: true })).toBe(false);
	});

	it("builds when the target sha moved", () => {
		expect(shouldSkipBuild({ ...base, targetSha: "def456" })).toBe(false);
	});

	it("builds when any inventoried artifact is missing", () => {
		expect(shouldSkipBuild({ ...base, stampArtifactsExist: false })).toBe(false);
	});

	it("builds when the inventory is empty", () => {
		expect(shouldSkipBuild({ ...base, stamp: { ...stamp, artifacts: [] } })).toBe(false);
	});

	it("builds when no stamp exists at all", () => {
		expect(shouldSkipBuild({ ...base, stamp: undefined })).toBe(false);
	});

	it("builds when the stamp belongs to a different repo root", () => {
		expect(shouldSkipBuild({ ...base, repoRoot: "/other/repo" })).toBe(false);
	});
});

describe("runOmoLocalUpdateBeta stub", () => {
	it("no-ops under the kill-switch", async () => {
		const root = makeTempRoot();
		const { pluginPath, agentDir } = makeOmoLayout(root);
		await expect(
			runOmoLocalUpdateBeta({
				env: { SENPI_OMO_LOCAL_UPDATE: "0" },
				agentDir,
				settings: { packages: [pluginPath] },
			}),
		).resolves.toBeUndefined();
		expect(readStamp(agentDir)).toBeUndefined();
	});

	it("no-ops when nothing is detected", async () => {
		const root = makeTempRoot();
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		await expect(
			runOmoLocalUpdateBeta({ env: {}, agentDir, settings: { packages: ["npm:@scope/other"] } }),
		).resolves.toBeUndefined();
	});
});

function headSha(cwd: string): string {
	return git(["rev-parse", "HEAD"], cwd);
}

function currentBranch(cwd: string): string | undefined {
	try {
		return git(["symbolic-ref", "--short", "-q", "HEAD"], cwd) || undefined;
	} catch {
		return undefined;
	}
}

function makeLogCollector(): { lines: string[]; log: (message: string) => void } {
	const lines: string[] = [];
	return {
		lines,
		log: (message: string) => {
			lines.push(message);
		},
	};
}

/** Fetch origin/dev in the fixture clone (the orchestrator's job) and return the frozen sha. */
function fetchTargetSha(repoRoot: string): string {
	git(["fetch", "origin", "dev"], repoRoot);
	return git(["rev-parse", "origin/dev"], repoRoot);
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error;
	}
}

describe("classifyDirt", () => {
	it("classifies tracked modifications under every generated prefix as generated", () => {
		const porcelain = `${[
			" M packages/omo-senpi/plugin/extensions/omo.js",
			" M packages/omo-senpi/plugin/skills/alpha/SKILL.md",
			" M packages/omo-senpi/plugin/runtime/lsp-daemon/dist/cli.js",
			" M packages/omo-senpi/plugin/scripts/install.mjs",
		].join("\0")}\0`;
		const dirt = classifyDirt(porcelain);
		expect(dirt.source).toEqual([]);
		expect(dirt.generated.map((entry) => entry.path)).toEqual([
			"packages/omo-senpi/plugin/extensions/omo.js",
			"packages/omo-senpi/plugin/skills/alpha/SKILL.md",
			"packages/omo-senpi/plugin/runtime/lsp-daemon/dist/cli.js",
			"packages/omo-senpi/plugin/scripts/install.mjs",
		]);
	});

	it("classifies untracked entries by path and marks them untracked", () => {
		const porcelain = `${["?? packages/omo-senpi/plugin/skills/newskill/", "?? packages/omo-senpi/src/new-file.ts"].join("\0")}\0`;
		const dirt = classifyDirt(porcelain);
		expect(dirt.generated).toEqual([{ path: "packages/omo-senpi/plugin/skills/newskill/", untracked: true }]);
		expect(dirt.source).toEqual([{ path: "packages/omo-senpi/src/new-file.ts", untracked: true }]);
	});

	it("treats files merely NEAR the generated prefixes as source", () => {
		const porcelain = `${[
			" M packages/omo-senpi/plugin/scripts/other.mjs",
			" M packages/omo-senpi/plugin/extensions.json",
			" M packages/omo-senpi/plugin/package.json",
		].join("\0")}\0`;
		const dirt = classifyDirt(porcelain);
		expect(dirt.generated).toEqual([]);
		expect(dirt.source).toHaveLength(3);
	});

	it("keeps a rename fully inside the generated prefixes generated, recording the source path", () => {
		const porcelain =
			"R  packages/omo-senpi/plugin/skills/beta/SKILL.md\0packages/omo-senpi/plugin/skills/alpha/SKILL.md\0";
		const dirt = classifyDirt(porcelain);
		expect(dirt.source).toEqual([]);
		expect(dirt.generated).toEqual([
			{
				path: "packages/omo-senpi/plugin/skills/beta/SKILL.md",
				origPath: "packages/omo-senpi/plugin/skills/alpha/SKILL.md",
				untracked: false,
			},
		]);
	});

	it("classifies a rename as source when EITHER half leaves the generated prefixes", () => {
		const generatedToSource =
			"R  packages/omo-senpi/src/alpha-skill.md\0packages/omo-senpi/plugin/skills/alpha/SKILL.md\0";
		const sourceToGenerated =
			"R  packages/omo-senpi/plugin/skills/alpha/SKILL.md\0packages/omo-senpi/src/alpha-skill.md\0";
		for (const porcelain of [generatedToSource, sourceToGenerated]) {
			const dirt = classifyDirt(porcelain);
			expect(dirt.generated).toEqual([]);
			expect(dirt.source).toHaveLength(1);
			expect(dirt.source[0]?.origPath).toBeDefined();
		}
	});

	it("handles an empty status and mixed streams", () => {
		expect(classifyDirt("")).toEqual({ generated: [], source: [] });
		const porcelain = `${[
			" M packages/omo-senpi/plugin/extensions/omo.js",
			" M packages/omo-senpi/src/index.ts",
			"?? packages/omo-senpi/plugin/runtime/extra.js",
		].join("\0")}\0`;
		const dirt = classifyDirt(porcelain);
		expect(dirt.generated).toHaveLength(2);
		expect(dirt.source).toHaveLength(1);
	});
});

describe("syncToOriginDev", () => {
	it("fast-forwards a clean checkout to the frozen origin/dev sha", { timeout: 30000 }, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		advanceOriginDev(fixture.originDir);
		const targetSha = fetchTargetSha(fixture.repoRoot);
		const { log } = makeLogCollector();
		const report = await syncToOriginDev({ repoRoot: fixture.repoRoot, targetSha, run: defaultRun, log });
		expect(headSha(fixture.repoRoot)).toBe(targetSha);
		expect(currentBranch(fixture.repoRoot)).toBe("dev");
		expect(git(["rev-parse", "dev"], fixture.repoRoot)).toBe(targetSha);
		expect(report.prevRef).toBe("dev");
		expect(report.subject).toBe("origin dev commit 2");
		expect(report.backupBranch).toBeUndefined();
		expect(report.detached).toBeUndefined();
		expect(report.discardedPaths).toEqual([]);
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toBe("");
	});

	it("discards generated-only dirt (tracked and untracked) without any backup branch", {
		timeout: 30000,
	}, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		const generatedPath = dirtyGenerated(fixture.repoRoot);
		const untrackedDir = join(fixture.repoRoot, "packages", "omo-senpi", "plugin", "skills", "newskill");
		mkdirSync(untrackedDir, { recursive: true });
		writeFileSync(join(untrackedDir, "SKILL.md"), "# junk\n");
		const targetSha = git(["rev-parse", "origin/dev"], fixture.repoRoot);
		const { log } = makeLogCollector();
		const report = await syncToOriginDev({ repoRoot: fixture.repoRoot, targetSha, run: defaultRun, log });
		expect(report.backupBranch).toBeUndefined();
		expect(git(["branch", "--list", "backup/*"], fixture.repoRoot)).toBe("");
		expect(report.discardedPaths).toContain(generatedPath);
		expect(report.discardedPaths).toContain("packages/omo-senpi/plugin/skills/newskill/");
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toBe("");
		expect(headSha(fixture.repoRoot)).toBe(targetSha);
		expect(currentBranch(fixture.repoRoot)).toBe("dev");
	});

	it("backs up source dirt to a PUSHED backup branch, then syncs dev to the target", { timeout: 30000 }, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		dirtySource(fixture.repoRoot);
		advanceOriginDev(fixture.originDir);
		const targetSha = fetchTargetSha(fixture.repoRoot);
		const { log } = makeLogCollector();
		const report = await syncToOriginDev({ repoRoot: fixture.repoRoot, targetSha, run: defaultRun, log });
		if (report.backupBranch === undefined) throw new Error("expected a backup branch");
		expect(report.backupBranch).toMatch(/^backup\/senpi-update-\d{8}-\d{6}Z$/);
		expect(report.backupPushed).toBe(true);
		// The backup branch exists on the bare origin and carries exactly the snapshot commit.
		expect(git(["-C", fixture.originDir, "branch", "--list", report.backupBranch], ".")).not.toBe("");
		const ahead = git(["log", `origin/dev..${report.backupBranch}`, "--oneline"], fixture.repoRoot);
		expect(ahead.split("\n")).toHaveLength(1);
		const snapshot = git(["show", `${report.backupBranch}:packages/omo-senpi/src/index.ts`], fixture.repoRoot);
		expect(snapshot).toContain("fixture source dirt");
		// Worktree clean, dev synced, previous branch ref unchanged.
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toBe("");
		expect(git(["rev-parse", "dev"], fixture.repoRoot)).toBe(targetSha);
		expect(report.prevRef).toBe("dev");
		expect(currentBranch(fixture.repoRoot)).toBe("dev");
		expect(headSha(fixture.repoRoot)).toBe(targetSha);
	});

	it("keeps the backup branch locally (with a warning) when the push is rejected", { timeout: 30000 }, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		dirtySource(fixture.repoRoot);
		blockPushes(fixture.originDir);
		const targetSha = git(["rev-parse", "origin/dev"], fixture.repoRoot);
		const { lines, log } = makeLogCollector();
		const report = await syncToOriginDev({ repoRoot: fixture.repoRoot, targetSha, run: defaultRun, log });
		if (report.backupBranch === undefined) throw new Error("expected a backup branch");
		expect(report.backupPushed).toBe(false);
		// Local branch retains the snapshot; origin rejected it.
		expect(git(["rev-parse", report.backupBranch], fixture.repoRoot)).not.toBe("");
		expect(git(["-C", fixture.originDir, "branch", "--list", "backup/*"], ".")).toBe("");
		const snapshot = git(["show", `${report.backupBranch}:packages/omo-senpi/src/index.ts`], fixture.repoRoot);
		expect(snapshot).toContain("fixture source dirt");
		expect(lines.some((line) => line.includes(report.backupBranch ?? "\0") && line.includes("locally"))).toBe(true);
		// Sync still completes.
		expect(headSha(fixture.repoRoot)).toBe(targetSha);
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toBe("");
	});

	it("detaches at the frozen target when local dev has diverged, leaving local commits intact", {
		timeout: 30000,
	}, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		const { localSha, originSha } = divergeLocalDev(fixture.repoRoot);
		const { lines, log } = makeLogCollector();
		const report = await syncToOriginDev({ repoRoot: fixture.repoRoot, targetSha: originSha, run: defaultRun, log });
		expect(report.detached).toBe(true);
		expect(headSha(fixture.repoRoot)).toBe(originSha);
		expect(currentBranch(fixture.repoRoot)).toBeUndefined();
		expect(git(["rev-parse", "dev"], fixture.repoRoot)).toBe(localSha);
		expect(lines.some((line) => line.includes("detached"))).toBe(true);
	});

	it("detaches at the frozen target when local dev is AHEAD of origin (never builds local-only commits)", {
		timeout: 30000,
	}, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		const localSha = advanceLocalDevOnly(fixture.repoRoot);
		const targetSha = git(["rev-parse", "origin/dev"], fixture.repoRoot);
		expect(localSha).not.toBe(targetSha);
		const { log } = makeLogCollector();
		const report = await syncToOriginDev({ repoRoot: fixture.repoRoot, targetSha, run: defaultRun, log });
		expect(report.detached).toBe(true);
		expect(headSha(fixture.repoRoot)).toBe(targetSha);
		expect(git(["rev-parse", "dev"], fixture.repoRoot)).toBe(localSha);
		expect(report.prevRef).toBe("dev");
	});

	it("creates an absent local dev AT the frozen target with upstream set, then checks it out", {
		timeout: 30000,
	}, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		deleteLocalDev(fixture.repoRoot);
		advanceOriginDev(fixture.originDir);
		const targetSha = fetchTargetSha(fixture.repoRoot);
		const { log } = makeLogCollector();
		const report = await syncToOriginDev({ repoRoot: fixture.repoRoot, targetSha, run: defaultRun, log });
		expect(report.prevRef).toBe("fixture-side");
		expect(git(["rev-parse", "dev"], fixture.repoRoot)).toBe(targetSha);
		expect(currentBranch(fixture.repoRoot)).toBe("dev");
		expect(git(["rev-parse", "--abbrev-ref", "dev@{upstream}"], fixture.repoRoot)).toBe("origin/dev");
		expect(headSha(fixture.repoRoot)).toBe(targetSha);
	});

	it("treats a rename across the generated/source boundary as source and snapshots it", {
		timeout: 30000,
	}, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		dirtyRenameAcrossSets(fixture.repoRoot);
		const targetSha = git(["rev-parse", "origin/dev"], fixture.repoRoot);
		const { log } = makeLogCollector();
		const report = await syncToOriginDev({ repoRoot: fixture.repoRoot, targetSha, run: defaultRun, log });
		if (report.backupBranch === undefined) throw new Error("expected a backup branch");
		const snapshot = git(["show", `${report.backupBranch}:packages/omo-senpi/src/alpha-skill.md`], fixture.repoRoot);
		expect(snapshot).toContain("alpha skill");
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toBe("");
		expect(headSha(fixture.repoRoot)).toBe(targetSha);
		expect(currentBranch(fixture.repoRoot)).toBe("dev");
	});

	it("rolls back and aborts when the backup COMMIT fails (dirt preserved, empty branch deleted)", {
		timeout: 30000,
	}, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		dirtySource(fixture.repoRoot);
		blockCommits(fixture.repoRoot);
		const devShaBefore = headSha(fixture.repoRoot);
		const targetSha = git(["rev-parse", "origin/dev"], fixture.repoRoot);
		const { log } = makeLogCollector();
		const failure = await captureFailure(
			syncToOriginDev({ repoRoot: fixture.repoRoot, targetSha, run: defaultRun, log }),
		);
		expect(failure).toBeInstanceOf(OmoLocalSyncError);
		expect((failure as OmoLocalSyncError).stage).toBe("backup");
		// prevRef restored, empty backup branch deleted, source dirt never destroyed.
		expect(currentBranch(fixture.repoRoot)).toBe("dev");
		expect(headSha(fixture.repoRoot)).toBe(devShaBefore);
		expect(git(["branch", "--list", "backup/*"], fixture.repoRoot)).toBe("");
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toContain("packages/omo-senpi/src/index.ts");
	});

	it("restores prevRef but KEEPS the backup ref when a later sync stage fails after a successful backup", {
		timeout: 30000,
	}, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		dirtySource(fixture.repoRoot);
		const devShaBefore = headSha(fixture.repoRoot);
		advanceOriginDev(fixture.originDir);
		const targetSha = fetchTargetSha(fixture.repoRoot);
		let failedOnce = false;
		const failFirstCheckoutDev: OmoLocalRun = async (command, args, options) => {
			if (!failedOnce && command === "git" && args[0] === "checkout" && args.includes("dev")) {
				failedOnce = true;
				return { code: 1, stdout: "", stderr: "error: simulated checkout refusal", timedOut: false };
			}
			return defaultRun(command, args, options);
		};
		const { log } = makeLogCollector();
		const failure = await captureFailure(
			syncToOriginDev({ repoRoot: fixture.repoRoot, targetSha, run: failFirstCheckoutDev, log }),
		);
		expect(failure).toBeInstanceOf(OmoLocalSyncError);
		expect((failure as OmoLocalSyncError).stage).toBe("sync");
		// prevRef restored to its exact pre-sync commit; the snapshot backup ref is retained.
		expect(currentBranch(fixture.repoRoot)).toBe("dev");
		expect(headSha(fixture.repoRoot)).toBe(devShaBefore);
		expect(git(["branch", "--list", "backup/*"], fixture.repoRoot)).not.toBe("");
	});

	it("reports prevRef as the detached HEAD sha when starting detached", { timeout: 30000 }, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		git(["checkout", "--detach", "HEAD"], fixture.repoRoot);
		const detachedSha = headSha(fixture.repoRoot);
		dirtySource(fixture.repoRoot);
		const targetSha = git(["rev-parse", "origin/dev"], fixture.repoRoot);
		const { log } = makeLogCollector();
		const report = await syncToOriginDev({ repoRoot: fixture.repoRoot, targetSha, run: defaultRun, log });
		expect(report.prevRef).toBe(detachedSha);
		expect(report.backupBranch).toBeDefined();
		expect(report.backupPushed).toBe(true);
		expect(headSha(fixture.repoRoot)).toBe(targetSha);
		expect(currentBranch(fixture.repoRoot)).toBe("dev");
	});
});

function makeSpyRun(): { calls: string[][]; run: OmoLocalRun } {
	const calls: string[][] = [];
	return {
		calls,
		run: (command, args, options) => {
			calls.push([command, ...args]);
			return defaultRun(command, args, options);
		},
	};
}

/**
 * Executable `bun` stand-in for orchestrator tests: `bun install` succeeds quietly;
 * `bun run build:senpi-plugin` runs the fixture's real stub build. FAKE_BUN_BUILD_FAIL
 * makes the build exit 1 after writing artifacts; FAKE_BUN_SOURCE_LEFTOVER additionally
 * drops a NEW source-path file (post-failure SOURCE dirt).
 */
function installFakeBun(binDir: string): void {
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
		'  if [ -n "$FAKE_BUN_SOURCE_LEFTOVER" ]; then',
		'    echo "leftover" > packages/omo-senpi/src/build-leftover.txt',
		"  fi",
		'  if [ -n "$FAKE_BUN_BUILD_FAIL" ]; then',
		'    echo "// failed build leftover" >> packages/omo-senpi/plugin/extensions/omo.js',
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
function withPrependedPath(binDir: string): () => void {
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

describe("runOmoLocalUpdateBeta orchestrator", () => {
	function makeAgentDir(root: string): string {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		return agentDir;
	}

	it("runs the full happy path: fetch, sync, bun install/build via the real run seam, stamp, notify", {
		timeout: 60000,
	}, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const { calls, run } = makeSpyRun();
		const { lines, log } = makeLogCollector();
		try {
			await expect(
				runOmoLocalUpdateBeta({
					env: {},
					agentDir,
					settings: { packages: [fixture.pluginPath] },
					log,
					run,
				}),
			).resolves.toBeUndefined();
		} finally {
			restorePath();
		}
		const targetSha = git(["rev-parse", "origin/dev"], fixture.repoRoot);
		const short = targetSha.slice(0, 7);
		// Green success line with the short sha + subject of the FROZEN commit.
		expect(lines).toContain(
			`Updated OMO local plugins (omo-senpi + senpi-task) to origin/dev @${short} - fixture: seed fake omo repo`,
		);
		// Dim progress lines for fetch/install/build.
		expect(lines.some((line) => line.includes("Updating OMO local plugins: fetching origin/dev..."))).toBe(true);
		expect(lines.some((line) => line.includes("Updating OMO local plugins: installing deps..."))).toBe(true);
		expect(lines.some((line) => line.includes("Updating OMO local plugins: building plugin..."))).toBe(true);
		// The REAL run seam received the exact bun argv.
		expect(calls).toContainEqual(["bun", "install"]);
		expect(calls).toContainEqual(["bun", "run", "build:senpi-plugin"]);
		// The stub build wrote the full artifact set; the stamp records the post-build inventory.
		for (const artifact of FIXTURE_PLUGIN_ARTIFACTS) {
			expect(existsSync(join(fixture.pluginPath, artifact))).toBe(true);
		}
		const stamp = readStamp(agentDir);
		expect(stamp?.repoRoot).toBe(fixture.repoRoot);
		expect(stamp?.builtSha).toBe(targetSha);
		expect(stamp?.artifacts).toEqual([...FIXTURE_PLUGIN_ARTIFACTS].sort());
		expect(headSha(fixture.repoRoot)).toBe(targetSha);
		expect(currentBranch(fixture.repoRoot)).toBe("dev");
		// Lock released by the finally.
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(false);
	});

	it("emits the detached-build success variant when local dev has diverged", { timeout: 60000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const { localSha, originSha } = divergeLocalDev(fixture.repoRoot);
		const { lines, log } = makeLogCollector();
		try {
			await runOmoLocalUpdateBeta({
				env: {},
				agentDir,
				settings: { packages: [fixture.pluginPath] },
				log,
				run: defaultRun,
			});
		} finally {
			restorePath();
		}
		const short = originSha.slice(0, 7);
		expect(
			lines.some((line) => line.includes("local dev has commits not on origin/dev") && line.includes("detached")),
		).toBe(true);
		expect(lines).toContain(
			`Built OMO local plugins (omo-senpi + senpi-task) from origin/dev @${short} - origin dev commit 2 (detached HEAD)`,
		);
		expect(headSha(fixture.repoRoot)).toBe(originSha);
		expect(currentBranch(fixture.repoRoot)).toBeUndefined();
		expect(git(["rev-parse", "dev"], fixture.repoRoot)).toBe(localSha);
		expect(readStamp(agentDir)?.builtSha).toBe(originSha);
	});

	it("skips the rebuild on a second run, and declines the skip when a stamped skills file is deleted", {
		timeout: 90000,
	}, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const { calls, run } = makeSpyRun();
		const targetSha = git(["rev-parse", "origin/dev"], fixture.repoRoot);
		const short = targetSha.slice(0, 7);
		const base = { env: {}, agentDir, settings: { packages: [fixture.pluginPath] }, run };
		try {
			const first = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, log: first.log });
			expect(first.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);

			// Second run: dim skip line, and the skip touches NOTHING (no bun, no classify/sync git calls).
			calls.length = 0;
			const second = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, log: second.log });
			expect(second.lines.some((line) => line.includes(`already at origin/dev @${short}`))).toBe(true);
			expect(second.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(false);
			expect(calls.some(([command]) => command === "bun")).toBe(false);
			expect(
				calls.some(([, ...args]) => args.includes("status") || args.includes("checkout") || args.includes("merge")),
			).toBe(false);
			expect(git(["status", "--porcelain"], fixture.repoRoot)).toBe("");

			// Deleting one stamped skills file declines the skip -> full rebuild.
			const stampedSkill = join(fixture.pluginPath, "skills", "alpha", "SKILL.md");
			expect(readStamp(agentDir)?.artifacts).toContain("skills/alpha/SKILL.md");
			rmSync(stampedSkill);
			calls.length = 0;
			const third = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, log: third.log });
			expect(third.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
			expect(calls).toContainEqual(["bun", "install"]);
			expect(calls).toContainEqual(["bun", "run", "build:senpi-plugin"]);
			expect(existsSync(stampedSkill)).toBe(true);
		} finally {
			restorePath();
		}
	});

	it("rebuilds when force is set even with a matching stamp", { timeout: 90000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const { calls, run } = makeSpyRun();
		const base = { env: {}, agentDir, settings: { packages: [fixture.pluginPath] }, run };
		try {
			const first = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, log: first.log });
			expect(first.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
			calls.length = 0;
			const second = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, force: true, log: second.log });
			expect(second.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
			expect(second.lines.some((line) => line.includes("already at origin/dev"))).toBe(false);
			expect(calls).toContainEqual(["bun", "install"]);
			expect(calls).toContainEqual(["bun", "run", "build:senpi-plugin"]);
		} finally {
			restorePath();
		}
	});

	it("warns once and skips when the bun binary is missing", { timeout: 60000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const noBun: OmoLocalRun = async (command, args, runOptions) => {
			if (command === "bun") {
				throw Object.assign(new Error("spawn bun ENOENT"), { code: "ENOENT" });
			}
			return defaultRun(command, args, runOptions);
		};
		const { lines, log } = makeLogCollector();
		await expect(
			runOmoLocalUpdateBeta({
				env: {},
				agentDir,
				settings: { packages: [fixture.pluginPath] },
				log,
				run: noBun,
			}),
		).resolves.toBeUndefined();
		expect(lines.filter((line) => line.includes("bun is required"))).toHaveLength(1);
		expect(lines.some((line) => line.includes("OMO local plugin update failed"))).toBe(false);
		expect(lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(false);
		expect(readStamp(agentDir)).toBeUndefined();
	});

	it("reports a build failure (yellow line, dim output tail, manual hint), writes no stamp, never throws", {
		timeout: 60000,
	}, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		process.env.FAKE_BUN_BUILD_FAIL = "1";
		const { lines, log } = makeLogCollector();
		try {
			await expect(
				runOmoLocalUpdateBeta({
					env: {},
					agentDir,
					settings: { packages: [fixture.pluginPath] },
					log,
					run: defaultRun,
				}),
			).resolves.toBeUndefined();
		} finally {
			restorePath();
			delete process.env.FAKE_BUN_BUILD_FAIL;
		}
		expect(lines.some((line) => line.includes("OMO local plugin update failed (build):"))).toBe(true);
		// The failed step's output tail is echoed (the stub wrote artifacts before exiting 1).
		expect(lines.some((line) => line.includes("fixture build:senpi-plugin wrote"))).toBe(true);
		expect(
			lines.some((line) =>
				line.includes(`git -C ${fixture.repoRoot} pull origin dev && bun install && bun run build:senpi-plugin`),
			),
		).toBe(true);
		expect(lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(false);
		expect(readStamp(agentDir)).toBeUndefined();
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(false);
		// No backup branch existed, so no restoration runs: the partial build state stays.
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toContain("packages/omo-senpi/plugin/extensions/omo.js");
	});

	it("restores prevRef and keeps the backup ref when the build fails after a source-dirt backup", {
		timeout: 60000,
	}, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		dirtySource(fixture.repoRoot);
		process.env.FAKE_BUN_BUILD_FAIL = "1";
		const targetSha = git(["rev-parse", "origin/dev"], fixture.repoRoot);
		const { lines, log } = makeLogCollector();
		try {
			await runOmoLocalUpdateBeta({
				env: {},
				agentDir,
				settings: { packages: [fixture.pluginPath] },
				log,
				run: defaultRun,
			});
		} finally {
			restorePath();
			delete process.env.FAKE_BUN_BUILD_FAIL;
		}
		expect(lines.some((line) => line.includes("OMO local plugin update failed (build):"))).toBe(true);
		expect(lines.some((line) => line.includes("backed up to backup/senpi-update-"))).toBe(true);
		// RESTORATION PROCEDURE ran: generated build leftovers discarded, prevRef checked out,
		// worktree clean, backup ref retained, no stamp.
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toBe("");
		expect(currentBranch(fixture.repoRoot)).toBe("dev");
		expect(headSha(fixture.repoRoot)).toBe(targetSha);
		expect(git(["branch", "--list", "backup/*"], fixture.repoRoot)).not.toBe("");
		expect(readStamp(agentDir)).toBeUndefined();
	});

	it("preserves the worktree untouched and warns when post-failure SOURCE dirt blocks restoration", {
		timeout: 60000,
	}, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		dirtySource(fixture.repoRoot);
		process.env.FAKE_BUN_BUILD_FAIL = "1";
		process.env.FAKE_BUN_SOURCE_LEFTOVER = "1";
		const { lines, log } = makeLogCollector();
		try {
			await runOmoLocalUpdateBeta({
				env: {},
				agentDir,
				settings: { packages: [fixture.pluginPath] },
				log,
				run: defaultRun,
			});
		} finally {
			restorePath();
			delete process.env.FAKE_BUN_BUILD_FAIL;
			delete process.env.FAKE_BUN_SOURCE_LEFTOVER;
		}
		// Restoration-failed warning (naming prevRef) comes BEFORE the failure warning.
		const restoreIndex = lines.findIndex((line) => line.includes("could not restore dev"));
		const failureIndex = lines.findIndex((line) => line.includes("OMO local plugin update failed (build):"));
		expect(restoreIndex).toBeGreaterThanOrEqual(0);
		expect(failureIndex).toBeGreaterThan(restoreIndex);
		// Worktree preserved untouched: the new source-path file AND the generated leftovers
		// are all still there; the backup ref is kept; no stamp.
		expect(existsSync(join(fixture.repoRoot, "packages", "omo-senpi", "src", "build-leftover.txt"))).toBe(true);
		const status = git(["status", "--porcelain"], fixture.repoRoot);
		expect(status).toContain("build-leftover.txt");
		expect(status).toContain("packages/omo-senpi/plugin/extensions/omo.js");
		expect(git(["branch", "--list", "backup/*"], fixture.repoRoot)).not.toBe("");
		expect(readStamp(agentDir)).toBeUndefined();
	});

	it("downgrades a fetch failure to a yellow warning and leaves the repo untouched", {
		timeout: 60000,
	}, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		git(["remote", "set-url", "origin", join(root, "does-not-exist.git")], fixture.repoRoot);
		const headBefore = headSha(fixture.repoRoot);
		const { lines, log } = makeLogCollector();
		await expect(
			runOmoLocalUpdateBeta({
				env: {},
				agentDir,
				settings: { packages: [fixture.pluginPath] },
				log,
				run: defaultRun,
			}),
		).resolves.toBeUndefined();
		expect(lines.some((line) => line.includes("OMO local plugin update failed (fetch):"))).toBe(true);
		expect(lines.some((line) => line.includes(`git -C ${fixture.repoRoot} pull origin dev`))).toBe(true);
		expect(headSha(fixture.repoRoot)).toBe(headBefore);
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toBe("");
		expect(readStamp(agentDir)).toBeUndefined();
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(false);
	});

	it("allows exactly one of two simultaneous runs to proceed", { timeout: 90000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const { lines, log } = makeLogCollector();
		const options = {
			env: {},
			agentDir,
			settings: { packages: [fixture.pluginPath] },
			log,
			run: defaultRun,
		};
		try {
			await expect(Promise.all([runOmoLocalUpdateBeta(options), runOmoLocalUpdateBeta(options)])).resolves.toEqual([
				undefined,
				undefined,
			]);
		} finally {
			restorePath();
		}
		expect(lines.filter((line) => line.includes("Updated OMO local plugins"))).toHaveLength(1);
		expect(lines.filter((line) => line.includes("already running (pid"))).toHaveLength(1);
		expect(readStamp(agentDir)).toBeDefined();
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(false);
	});

	it("reclaims the lock from a dead pid and proceeds", { timeout: 60000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		if (deadPid === undefined) throw new Error("expected a child pid");
		writeFileSync(
			omoLocalUpdateLockPath(agentDir),
			JSON.stringify({ pid: deadPid, nonce: "stale", startedAt: "2020-01-01T00:00:00.000Z" }),
		);
		const { lines, log } = makeLogCollector();
		try {
			await runOmoLocalUpdateBeta({
				env: {},
				agentDir,
				settings: { packages: [fixture.pluginPath] },
				log,
				run: defaultRun,
			});
		} finally {
			restorePath();
		}
		expect(lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
		expect(readStamp(agentDir)).toBeDefined();
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(false);
	});

	it("never takes over a live pid's lock, regardless of age", { timeout: 60000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		writeFileSync(
			omoLocalUpdateLockPath(agentDir),
			JSON.stringify({ pid: process.pid, nonce: "someone-else", startedAt: "2020-01-01T00:00:00.000Z" }),
		);
		const { calls, run } = makeSpyRun();
		const { lines, log } = makeLogCollector();
		await runOmoLocalUpdateBeta({
			env: {},
			agentDir,
			settings: { packages: [fixture.pluginPath] },
			log,
			run,
		});
		expect(lines.some((line) => line.includes(`already running (pid ${process.pid})`))).toBe(true);
		// No fetch, no sync, no build - nothing but detection ran.
		expect(calls.some(([, ...args]) => args.includes("fetch"))).toBe(false);
		expect(calls.some(([command]) => command === "bun")).toBe(false);
		expect(readStamp(agentDir)).toBeUndefined();
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toBe("");
		// The other owner's lock is left in place.
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(true);
	});

	it("kill-switch run has zero fs/git side effects", { timeout: 60000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const headBefore = headSha(fixture.repoRoot);
		const { calls, run } = makeSpyRun();
		const { lines, log } = makeLogCollector();
		await runOmoLocalUpdateBeta({
			env: { SENPI_OMO_LOCAL_UPDATE: "0" },
			agentDir,
			settings: { packages: [fixture.pluginPath] },
			log,
			run,
		});
		expect(lines).toEqual([]);
		expect(calls).toEqual([]);
		expect(headSha(fixture.repoRoot)).toBe(headBefore);
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toBe("");
		expect(readStamp(agentDir)).toBeUndefined();
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(false);
	});
});
