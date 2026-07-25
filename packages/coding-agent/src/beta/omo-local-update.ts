// BETA(omo-local-update): removable beta module - delete this file, all test/omo-local-update*
// files, and the two marked touch points in src/package-manager-cli.ts to drop the feature.
//
// Beta: on bare `senpi update`, sync a locally-installed OMO plugin checkout (omo-senpi +
// senpi-task) to origin/dev, rebuild the plugin bundle, and notify - before senpi updates
// itself. See .omo/plans/senpi-update-omo-local-beta.md.
//
// Export policy: `runOmoLocalUpdateBeta` is the ONLY production API and the only symbol the
// CLI may import. Every other export in this module is /** exported for tests only */ so the
// single test file (test/omo-local-update.test.ts) can exercise helpers directly - no
// CLI-side helper imports, no logic duplication.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PackageSource } from "../core/settings-manager.ts";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";
import { canonicalizePath, isLocalPath, resolvePath } from "../utils/paths.ts";
import { killProcessTree } from "../utils/shell.ts";

/** Result of one spawned command, with output captured and timeout enforced. */
export interface OmoLocalRunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface OmoLocalRunOptions {
	cwd?: string;
	timeoutMs?: number;
	/** Merged over process.env (callers inject the isolated git env from the fixture contract). */
	env?: Record<string, string | undefined>;
}

/** exported for tests only */
export type OmoLocalRun = (command: string, args: string[], options: OmoLocalRunOptions) => Promise<OmoLocalRunResult>;

/**
 * exported for tests only
 *
 * Shared process seam for the whole module. spawnProcess/waitForChildProcess neither capture
 * output nor enforce timeouts; this adds both. The child is spawned detached on POSIX so it
 * owns a process group, and the timeout kill goes through killProcessTree (SIGKILL to the
 * whole group) - without that, bun/git descendants would keep mutating the checkout after
 * the direct child died.
 */
export async function defaultRun(
	command: string,
	args: string[],
	options: OmoLocalRunOptions,
): Promise<OmoLocalRunResult> {
	const child = spawnProcess(command, args, {
		cwd: options.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...options.env },
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const abort = new AbortController();
	let timedOut = false;
	const pid = child.pid;
	const timer =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					if (pid !== undefined) {
						killProcessTree(pid);
					}
					abort.abort();
				}, options.timeoutMs);
	try {
		const code = await waitForChildProcess(child, { signal: abort.signal });
		return { code, stdout, stderr, timedOut };
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/** exported for tests only */
export function isKillSwitched(env: Record<string, string | undefined>): boolean {
	return env.SENPI_OMO_LOCAL_UPDATE === "0";
}

/** A detected locally-installed OMO plugin and its enclosing omo monorepo checkout. */
export interface OmoLocalInstall {
	pluginPath: string;
	repoRoot: string;
}

/** exported for tests only */
export interface DetectOmoLocalInstallOptions {
	packages: PackageSource[] | undefined;
	agentDir: string;
	run: OmoLocalRun;
	readJson?: (path: string) => unknown;
	exists?: (path: string) => boolean;
}

function defaultReadJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return undefined;
	}
}

function packageNameOf(json: unknown): string | undefined {
	if (typeof json !== "object" || json === null) {
		return undefined;
	}
	const name = (json as { name?: unknown }).name;
	return typeof name === "string" ? name : undefined;
}

/** Same semantics as package-manager.ts's private getHomeDir (HOME env wins over os.homedir). */
function homeDir(): string {
	return process.env.HOME || homedir();
}

/**
 * exported for tests only
 *
 * Three-part detection gate (ALL must hold, else silent no-op):
 * 1. A global settings `packages` entry (string or object form) is a local path whose resolved
 *    dir's package.json name is `@code-yeongyu/omo-senpi`.
 * 2. The derived repo root (pluginPath/../../..) contains both workspace packages
 *    `@oh-my-opencode/omo-senpi` and `@oh-my-opencode/senpi-task`.
 * 3. `git -C <repoRoot> rev-parse --show-toplevel` succeeds AND its canonicalized output equals
 *    the canonicalized repo root - a mismatched toplevel would let later `git add -A` stage an
 *    enclosing repo's files.
 */
export async function detectOmoLocalInstall(
	options: DetectOmoLocalInstallOptions,
): Promise<OmoLocalInstall | undefined> {
	const readJson = options.readJson ?? defaultReadJson;
	const exists = options.exists ?? existsSync;
	if (!options.packages) {
		return undefined;
	}
	for (const entry of options.packages) {
		const source = typeof entry === "string" ? entry : entry.source;
		if (!isLocalPath(source)) {
			continue;
		}
		const pluginPath = resolvePath(source, options.agentDir, { homeDir: homeDir(), trim: true });
		if (packageNameOf(readJson(join(pluginPath, "package.json"))) !== "@code-yeongyu/omo-senpi") {
			continue;
		}
		const repoRoot = resolve(pluginPath, "..", "..", "..");
		const omoSenpiPkgPath = join(repoRoot, "packages", "omo-senpi", "package.json");
		const senpiTaskPkgPath = join(repoRoot, "packages", "senpi-task", "package.json");
		if (!exists(omoSenpiPkgPath) || packageNameOf(readJson(omoSenpiPkgPath)) !== "@oh-my-opencode/omo-senpi") {
			continue;
		}
		if (!exists(senpiTaskPkgPath) || packageNameOf(readJson(senpiTaskPkgPath)) !== "@oh-my-opencode/senpi-task") {
			continue;
		}
		let topLevel: string;
		try {
			const result = await options.run("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], {});
			if (result.code !== 0) {
				continue;
			}
			topLevel = result.stdout.trim();
		} catch {
			continue;
		}
		if (topLevel === "" || canonicalizePath(topLevel) !== canonicalizePath(repoRoot)) {
			continue;
		}
		return { pluginPath, repoRoot };
	}
	return undefined;
}

/** Skip-stamp written after a successful build: `<agentDir>/omo-local-update-state.json`. */
export interface OmoLocalUpdateStamp {
	repoRoot: string;
	builtSha: string;
	builtAt: string;
	/** Post-build inventory: relative paths of every built artifact present at stamp time. */
	artifacts: string[];
}

/** exported for tests only */
export function omoLocalUpdateStampPath(agentDir: string): string {
	return join(agentDir, "omo-local-update-state.json");
}

/** exported for tests only */
export function readStamp(agentDir: string): OmoLocalUpdateStamp | undefined {
	const json = defaultReadJson(omoLocalUpdateStampPath(agentDir));
	if (typeof json !== "object" || json === null) {
		return undefined;
	}
	const candidate = json as { repoRoot?: unknown; builtSha?: unknown; builtAt?: unknown; artifacts?: unknown };
	if (
		typeof candidate.repoRoot !== "string" ||
		typeof candidate.builtSha !== "string" ||
		typeof candidate.builtAt !== "string" ||
		!Array.isArray(candidate.artifacts)
	) {
		return undefined;
	}
	const artifacts: string[] = [];
	for (const artifact of candidate.artifacts as unknown[]) {
		if (typeof artifact !== "string") {
			return undefined;
		}
		artifacts.push(artifact);
	}
	return {
		repoRoot: candidate.repoRoot,
		builtSha: candidate.builtSha,
		builtAt: candidate.builtAt,
		artifacts,
	};
}

/** exported for tests only */
export function writeStamp(agentDir: string, stamp: OmoLocalUpdateStamp): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(omoLocalUpdateStampPath(agentDir), `${JSON.stringify(stamp, null, 2)}\n`, "utf-8");
}

/** exported for tests only */
export interface ShouldSkipBuildOptions {
	stamp: OmoLocalUpdateStamp | undefined;
	repoRoot: string;
	targetSha: string;
	/** True only when every path recorded in stamp.artifacts still exists on disk. */
	stampArtifactsExist: boolean;
	force: boolean;
}

/**
 * exported for tests only
 *
 * Skip decision (taken BEFORE any worktree mutation): skip only when the stamp belongs to this
 * repo root, was built at the frozen target sha, recorded a non-empty artifact inventory, and
 * every inventoried path still exists. A repoRoot mismatch always rebuilds; an empty/absent
 * inventory never skips.
 */
export function shouldSkipBuild(options: ShouldSkipBuildOptions): boolean {
	if (options.force) {
		return false;
	}
	const stamp = options.stamp;
	if (!stamp) {
		return false;
	}
	if (stamp.repoRoot !== options.repoRoot) {
		return false;
	}
	if (stamp.builtSha !== options.targetSha) {
		return false;
	}
	if (stamp.artifacts.length === 0) {
		return false;
	}
	return options.stampArtifactsExist;
}

export interface RunOmoLocalUpdateBetaOptions {
	env: Record<string, string | undefined>;
	agentDir: string;
	settings?: { packages?: PackageSource[] };
	force?: boolean;
	log?: (message: string) => void;
	run?: OmoLocalRun;
}

/**
 * Beta hook entry point, called from bare `senpi update` before the self-update.
 *
 * STUB (todo 1): gate chain only - kill-switch, then detection. The ordered state machine
 * (lock -> fetch -> skip decision -> sync -> install/build -> stamp -> notify) lands in todo 4.
 * This hook NEVER throws and NEVER sets process.exitCode: any failure downgrades to a warning
 * so the senpi self-update continues untouched.
 */
export async function runOmoLocalUpdateBeta(options: RunOmoLocalUpdateBetaOptions): Promise<void> {
	try {
		if (isKillSwitched(options.env)) {
			return;
		}
		const install = await detectOmoLocalInstall({
			packages: options.settings?.packages,
			agentDir: options.agentDir,
			run: options.run ?? defaultRun,
		});
		if (!install) {
			return;
		}
		// todo 4: acquire lock -> fetch origin/dev -> skip decision -> syncToOriginDev ->
		// bun install -> bun run build:senpi-plugin -> completeness check -> write stamp -> notify.
	} catch {
		// Beta failures are never fatal; todo 4 renders the yellow failure line + manual hint.
	}
}
