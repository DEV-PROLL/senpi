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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import chalk from "chalk";
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

/** One parsed entry of `git status --porcelain=v1 -z` output. */
export interface OmoDirtEntry {
	/** The path git reports (for renames: the rename TARGET). */
	path: string;
	/** Rename source path, present only for R/C records. */
	origPath?: string;
	/** True for `??` untracked records. */
	untracked: boolean;
}

/** exported for tests only */
export interface OmoDirtClassification {
	generated: OmoDirtEntry[];
	source: OmoDirtEntry[];
}

const GENERATED_DIR_PREFIXES = [
	"packages/omo-senpi/plugin/extensions/",
	"packages/omo-senpi/plugin/skills/",
	"packages/omo-senpi/plugin/runtime/",
] as const;

const GENERATED_FILE_PATHS = new Set(["packages/omo-senpi/plugin/scripts/install.mjs"]);

function isGeneratedPath(path: string): boolean {
	if (GENERATED_FILE_PATHS.has(path)) {
		return true;
	}
	for (const prefix of GENERATED_DIR_PREFIXES) {
		if (path.startsWith(prefix)) {
			return true;
		}
	}
	return false;
}

/**
 * exported for tests only
 *
 * Parse `git status --porcelain=v1 -z` into GENERATED vs SOURCE dirt. With -z each record is
 * `XY <path>` NUL-terminated; rename/copy records carry a SECOND NUL-separated field holding
 * the ORIGINAL path (order: new then old, no arrow, no quoting). Rename rule (Scope): if
 * EITHER half of a rename lies outside the GENERATED prefixes, the whole rename is SOURCE.
 */
export function classifyDirt(porcelainZ: string): OmoDirtClassification {
	const fields = porcelainZ.split("\0");
	const generated: OmoDirtEntry[] = [];
	const source: OmoDirtEntry[] = [];
	let index = 0;
	while (index < fields.length) {
		const record = fields[index];
		index += 1;
		if (record === "") {
			continue;
		}
		const code = record.slice(0, 2);
		const entry: OmoDirtEntry = { path: record.slice(3), untracked: code === "??" };
		if (code.includes("R") || code.includes("C")) {
			const origPath = fields[index];
			index += 1;
			if (origPath !== undefined && origPath !== "") {
				entry.origPath = origPath;
			}
		}
		const isGenerated =
			isGeneratedPath(entry.path) && (entry.origPath === undefined || isGeneratedPath(entry.origPath));
		(isGenerated ? generated : source).push(entry);
	}
	return { generated, source };
}

function firstErrorLine(result: OmoLocalRunResult): string {
	for (const text of [result.stderr, result.stdout]) {
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed !== "") {
				return trimmed;
			}
		}
	}
	return "unknown error";
}

/** `YYYYMMDD-HHMMSSZ` in UTC, for `backup/senpi-update-<stamp>` branch names. */
function formatBackupTimestamp(date: Date): string {
	const iso = date.toISOString();
	return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}Z`;
}

/**
 * exported for tests only
 *
 * Sync failure carrying the state-machine stage ("classify" | "backup" | "discard" | "sync")
 * so the orchestrator can render `OMO local plugin update failed (<stage>): <first line>`.
 */
export class OmoLocalSyncError extends Error {
	readonly stage: string;
	constructor(stage: string, message: string) {
		super(message);
		this.name = "OmoLocalSyncError";
		this.stage = stage;
	}
}

/** exported for tests only */
export interface SyncToOriginDevReport {
	/** `git log -1 --format=%s <targetSha>` - read from the FROZEN sha, never the mutable ref. */
	subject: string;
	/** Restoration handle for later-stage failures: pre-sync branch name, or detached HEAD sha. */
	prevRef: string;
	backupBranch?: string;
	backupPushed?: boolean;
	/** True when local dev was ahead/diverged and the build happens detached at the target. */
	detached?: boolean;
	discardedPaths: string[];
}

/** exported for tests only */
export interface SyncToOriginDevOptions {
	repoRoot: string;
	/** Frozen origin/dev sha resolved ONCE by the orchestrator; every git op takes this literal. */
	targetSha: string;
	run: OmoLocalRun;
	log: (message: string) => void;
}

/**
 * exported for tests only
 *
 * Post-skip MUTATION HELPER (Scope ownership split): NEVER fetches, locks, skips, or stamps -
 * the orchestrator owns those and passes the frozen targetSha. Flow: capture prevRef ->
 * classify dirt -> back up SOURCE dirt to a pushed (or local-fallback) backup branch ->
 * discard GENERATED dirt -> branch triage under the FROZEN-SHA RULE -> mandatory
 * HEAD===targetSha postcondition. Forbidden git ops (reset --hard / clean -fd / stash /
 * force-push) are never used.
 */
export async function syncToOriginDev(options: SyncToOriginDevOptions): Promise<SyncToOriginDevReport> {
	const { repoRoot, targetSha, run, log } = options;
	const git = (args: string[]) => run("git", args, { cwd: repoRoot });
	const requireOk = async (stage: string, args: string[]): Promise<OmoLocalRunResult> => {
		const result = await git(args);
		if (result.code !== 0) {
			throw new OmoLocalSyncError(stage, `git ${args.join(" ")}: ${firstErrorLine(result)}`);
		}
		return result;
	};
	const discardGenerated = async (entries: OmoDirtEntry[]): Promise<boolean> => {
		const checkoutPaths: string[] = [];
		for (const entry of entries) {
			if (entry.untracked) {
				// Untracked files inside generated dirs: targeted fs.rm only.
				rmSync(join(repoRoot, entry.path), { recursive: true, force: true });
				continue;
			}
			// `checkout HEAD --` (not bare `checkout --`) so staged generated dirt resets from
			// HEAD too instead of being restored out of the index. For renames the TARGET path
			// is not in HEAD, so the SOURCE path is the checkout pathspec and the target file
			// is removed directly.
			if (entry.origPath !== undefined) {
				rmSync(join(repoRoot, entry.path), { recursive: true, force: true });
				checkoutPaths.push(entry.origPath);
			} else {
				checkoutPaths.push(entry.path);
			}
		}
		if (checkoutPaths.length === 0) {
			return true;
		}
		const result = await git(["checkout", "HEAD", "--", ...checkoutPaths]);
		return result.code === 0;
	};

	// Restoration handle: current branch name, or the detached HEAD sha.
	const symref = await git(["symbolic-ref", "--short", "-q", "HEAD"]);
	const prevRef =
		symref.code === 0 && symref.stdout.trim() !== ""
			? symref.stdout.trim()
			: (await requireOk("classify", ["rev-parse", "HEAD"])).stdout.trim();

	const status = await requireOk("classify", ["status", "--porcelain=v1", "-z"]);
	const dirt = classifyDirt(status.stdout);
	const discardedPaths = dirt.generated.map((entry) => entry.path);

	let backupBranch: string | undefined;
	let backupPushed: boolean | undefined;

	if (dirt.source.length > 0) {
		// SOURCE dirt is preserved via an auto backup branch created at current HEAD. `git add -A`
		// runs with cwd = repoRoot only and never stages ignored files, so the snapshot is all
		// tracked modifications + untracked non-ignored files (generated dirt included, for
		// snapshot fidelity).
		backupBranch = `backup/senpi-update-${formatBackupTimestamp(new Date())}`;
		await requireOk("backup", ["checkout", "-b", backupBranch]);
		await requireOk("backup", ["add", "-A"]);
		const commit = await git(["commit", "-m", `backup(senpi-update): auto snapshot from ${prevRef}`]);
		if (commit.code !== 0) {
			// Backup-COMMIT failure: roll back (restore prevRef, delete the empty backup branch)
			// and abort the sync. The pre-existing dirt rides along with the checkout - it is
			// never destroyed without a successful backup commit.
			const back = await git(["checkout", prevRef]);
			if (back.code !== 0) {
				log(
					chalk.yellow(
						`OMO local plugin update: backup commit failed AND restoring ${prevRef} failed: ${firstErrorLine(back)}`,
					),
				);
			}
			const del = await git(["branch", "-D", backupBranch]);
			if (del.code !== 0) {
				log(
					chalk.yellow(
						`OMO local plugin update: could not delete empty backup branch ${backupBranch}: ${firstErrorLine(del)}`,
					),
				);
			}
			throw new OmoLocalSyncError("backup", `git commit: ${firstErrorLine(commit)}`);
		}
		const push = await git(["push", "-u", "origin", backupBranch]);
		backupPushed = push.code === 0;
		if (!backupPushed) {
			// Push failure alone does NOT abort: the work is preserved in the snapshot commit.
			log(
				chalk.yellow(
					`OMO local plugin update: backup branch ${backupBranch} could not be pushed (kept locally only); your work is preserved in the snapshot commit.`,
				),
			);
		}
		// Everything (generated dirt included) is now committed on the backup branch, so the
		// worktree is fully clean: no explicit discard is needed on this path - the branch-triage
		// checkout resets generated files to the frozen target's versions.
	} else if (dirt.generated.length > 0) {
		if (!(await discardGenerated(dirt.generated))) {
			throw new OmoLocalSyncError("discard", "could not discard generated build-output dirt");
		}
	}

	const restoreAfterBackup = async (): Promise<void> => {
		// RESTORATION PROCEDURE (Scope): reclassify fresh, discard GENERATED-set entries only,
		// then checkout prevRef. Post-failure SOURCE dirt is never overwritten: leave the
		// worktree untouched, keep the backup ref, and warn explicitly.
		const keepNote = `your work is preserved on ${backupBranch ?? "the backup branch"}`;
		const fresh = await git(["status", "--porcelain=v1", "-z"]);
		if (fresh.code !== 0) {
			log(chalk.yellow(`OMO local plugin update: could not restore ${prevRef} (git status failed); ${keepNote}.`));
			return;
		}
		const freshDirt = classifyDirt(fresh.stdout);
		if (freshDirt.source.length > 0) {
			log(
				chalk.yellow(
					`OMO local plugin update: could not restore ${prevRef} - uncommitted source changes would be overwritten; leaving the worktree untouched (${keepNote}).`,
				),
			);
			return;
		}
		if (!(await discardGenerated(freshDirt.generated))) {
			log(
				chalk.yellow(
					`OMO local plugin update: could not restore ${prevRef} (generated-dirt discard failed); ${keepNote}.`,
				),
			);
			return;
		}
		const back = await git(["checkout", prevRef]);
		if (back.code !== 0) {
			log(
				chalk.yellow(
					`OMO local plugin update: could not restore ${prevRef}: ${firstErrorLine(back)} (${keepNote}).`,
				),
			);
		}
	};

	try {
		// Branch triage - FROZEN-SHA RULE: every ancestry/merge/detach/subject op below takes
		// the targetSha literal, never the mutable origin/dev ref.
		let detached = false;
		const devRes = await git(["rev-parse", "dev"]);
		if (devRes.code !== 0) {
			// Absent local dev: create FROM THE FROZEN COMMIT - never a DWIM checkout, which
			// would read the mutable origin/dev ref.
			await requireOk("sync", ["branch", "dev", targetSha]);
			await requireOk("sync", ["branch", "--set-upstream-to=origin/dev", "dev"]);
			await requireOk("sync", ["checkout", "dev"]);
		} else if (devRes.stdout.trim() === targetSha) {
			await requireOk("sync", ["checkout", "dev"]);
		} else {
			const ancestor = await git(["merge-base", "--is-ancestor", "dev", targetSha]);
			if (ancestor.code === 0) {
				// Strictly behind: plain fast-forward.
				await requireOk("sync", ["checkout", "dev"]);
				await requireOk("sync", ["merge", "--ff-only", targetSha]);
			} else if (ancestor.code === 1) {
				// AHEAD of or DIVERGED from the frozen target: never destroy or build local
				// commits - warn and build detached at the frozen sha.
				log(
					chalk.yellow(
						`OMO local plugin update: local dev has commits not on origin/dev; leaving them intact and building detached at origin/dev @${targetSha.slice(0, 7)}.`,
					),
				);
				await requireOk("sync", ["checkout", "--detach", targetSha]);
				detached = true;
			} else {
				throw new OmoLocalSyncError("sync", `git merge-base --is-ancestor: ${firstErrorLine(ancestor)}`);
			}
		}
		const subject = (await requireOk("sync", ["log", "-1", "--format=%s", targetSha])).stdout.trim();
		const head = (await requireOk("sync", ["rev-parse", "HEAD"])).stdout.trim();
		if (head !== targetSha) {
			throw new OmoLocalSyncError(
				"sync",
				`postcondition failed: HEAD is ${head.slice(0, 7)}, expected ${targetSha.slice(0, 7)}`,
			);
		}
		const report: SyncToOriginDevReport = { subject, prevRef, discardedPaths };
		if (backupBranch !== undefined) {
			report.backupBranch = backupBranch;
		}
		if (backupPushed !== undefined) {
			report.backupPushed = backupPushed;
		}
		if (detached) {
			report.detached = true;
		}
		return report;
	} catch (error) {
		// Any other git failure in the sequence: abort; if a backup commit already succeeded,
		// restore prevRef first while KEEPING the backup ref.
		if (backupBranch !== undefined) {
			await restoreAfterBackup();
		}
		throw error;
	}
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
