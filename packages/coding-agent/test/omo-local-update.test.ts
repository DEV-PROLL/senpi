import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	defaultRun,
	detectOmoLocalInstall,
	isKillSwitched,
	type OmoLocalUpdateStamp,
	omoLocalUpdateStampPath,
	readStamp,
	runOmoLocalUpdateBeta,
	shouldSkipBuild,
	writeStamp,
} from "../src/beta/omo-local-update.ts";

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
