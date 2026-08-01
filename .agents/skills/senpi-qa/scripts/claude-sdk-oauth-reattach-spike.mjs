#!/usr/bin/env node
/**
 * Live spike: re-attach mechanisms for the claude-sdk-oauth lane (Wave A todo 3).
 *
 * (a) resume-after-process-exit: a CHILD process owns query A (2 turns) and then
 *     exits entirely; the parent opens a new query with `resume: <same id>`,
 *     asserts coherence, and reports cache_read_input_tokens vs total prompt
 *     tokens on the resumed turn.
 * (b) cross-account resume: the resumed query authenticates as a DIFFERENT
 *     seeded sandbox slot under the SAME config root.
 * (c) config-root addressing: a session is seeded INTO a non-default root
 *     (CLAUDE_CONFIG_DIR=<scoped root> on the seeding child), then
 *     getSessionInfo/getSessionMessages + a resume run from a second child
 *     under the SAME scoped root, plus a static-only read under the default
 *     root. env-honored requires "visible under the scoped root AND absent
 *     from the default root"; visible under the default root means the SDK
 *     ignored CLAUDE_CONFIG_DIR (default-only). Seeding into the scoped root
 *     first is what makes env-honored reachable — probing a default-root
 *     session from an empty scoped root could only ever fail.
 *
 * Usage:
 *   SENPI_LIVE_CLAUDE_SDK_OAUTH=1 SENPI_CODING_AGENT_DIR=<sandbox> \
 *     node .agents/skills/senpi-qa/scripts/claude-sdk-oauth-reattach-spike.mjs
 *
 * Outcomes (final line):
 *   exit 0 "ACCEPTED resume=<ok> cache_read_ratio=<r> cross_account=<ok|denied|unseeded> config_root=<env-honored|default-only>"
 *   exit 2 "REJECTED signal=<sanitized>"   (e.g. resume_not_found)
 * cross_account is `unseeded` — never `ok` — when no distinct second account slot
 * (claude-sdk-oauth-spike-b) was seeded, so an untested arm cannot read as proven.
 * Never prints token material.
 */
import { execFileSync, fork } from "node:child_process";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	loadCredential,
	loadCredentialStrict,
	reject,
	requireLiveGate,
	requireSandbox,
	safeSignal,
	withTimeout,
} from "./lib/claude-sdk-oauth-spike-support.mjs";
import { runTurns, TOKEN_PROMPT } from "./lib/claude-sdk-oauth-reattach-worker.mjs";

const WORKER_FLAG = "--reattach-worker";
const SELF = fileURLToPath(import.meta.url);

if (process.argv.includes(WORKER_FLAG)) {
	// The request carries an OAuth access token, so it arrives over the IPC channel
	// rather than the environment: env is inherited by the Claude Code subprocess
	// this worker spawns, which would put the token in that process's environment.
	const request = await new Promise((resolve) => process.once("message", resolve));
	const result = await runTurns(request).catch((error) => ({
		error: error instanceof Error ? error.message : String(error),
	}));
	process.send?.(result, () => process.exit(0));
} else {
	requireLiveGate();
	const sandbox = requireSandbox();
	const primary = loadCredential(sandbox);
	if (primary.error) reject(primary.error);
	// STRICT: the forgiving loader falls back to the primary slot, which would let
	// the cross-account arm report `ok` without ever using a second account.
	const secondary = loadCredentialStrict(sandbox, "claude-sdk-oauth-spike-b");
	const token = `REATTACH_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

	const runChild = (request) => {
		let child;
		const run = new Promise((resolve, rejectRun) => {
			// detached: the worker gets its own process group so a timeout can
			// take its Claude Code grandchild down with it instead of orphaning
			// the grandchild to keep burning subscription quota.
			child = fork(SELF, [WORKER_FLAG], { silent: true, detached: process.platform !== "win32" });
			child.send(request);
			let received;
			child.once("message", (message) => {
				received = message;
			});
			child.once("error", rejectRun);
			child.once("exit", (code, signal) =>
				received ? resolve(received) : rejectRun(new Error(`worker_${signal ?? code ?? "exit"}`)),
			);
		});
		return withTimeout(run, "worker", 240_000).finally(() => terminateChild(child));
	};

	try {
		await main(runChild, primary, secondary, token);
	} catch (error) {
		// Spawn/IPC failures and worker timeouts must surface through the same
		// sanitized REJECTED contract as in-spike failures, never a raw exit 1.
		reject(error instanceof Error ? error.message : String(error));
	}
}

/** Kill a timed-out/failed worker AND its Claude Code grandchild (process group on POSIX, process tree on Windows). */
function terminateChild(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	try {
		if (process.platform === "win32") {
			// child.kill() cannot reach the grandchild on Windows — there is no
			// process group to signal — so take the whole tree down instead.
			execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			process.kill(-child.pid, "SIGKILL");
		}
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {}
	}
}

async function main(runChild, primary, secondary, token) {
	// (a) seed the session in a child process, then let that process die.
	const seeded = await runChild({
		access: primary.credential.access,
		prompts: [TOKEN_PROMPT(token), "Reply with exactly: SECOND"],
	});
	if (seeded.error) reject(seeded.error);
	if (!seeded.sessionId) reject("session_id_absent");

	// (a) resume the dead session from this process.
	const resumed = await runChild({
		access: primary.credential.access,
		resume: seeded.sessionId,
		prompts: ["Repeat the token I gave you at the start, prefixed with RECALL."],
		expectToken: token,
	});
	if (resumed.error) reject(resumed.error === "resume_failed" ? "resume_not_found" : resumed.error);
	if (!resumed.coherent) reject("resume_incoherent");
	const cacheRead = resumed.usage?.cacheRead ?? 0;
	const promptTokens = Math.max(1, (resumed.usage?.input ?? 0) + cacheRead + (resumed.usage?.cacheCreation ?? 0));
	const ratio = (cacheRead / promptTokens).toFixed(2);

	// (b) cross-account resume under the same config root. Without a genuinely
	// distinct slot B the arm is reported as `unseeded` — never as `ok` — so a
	// missing second account can never be mistaken for a proven capability.
	let crossAccount = "unseeded";
	if (secondary.error) {
		if (!secondary.error.startsWith("slot_missing_")) reject(secondary.error);
	} else if (secondary.credential.access === primary.credential.access) {
		reject("cross_account_slots_identical");
	} else {
		const crossed = await runChild({
			access: secondary.credential.access,
			resume: seeded.sessionId,
			prompts: ["Repeat the token I gave you at the start, prefixed with RECALL."],
			expectToken: token,
		});
		crossAccount = crossed.error || !crossed.coherent ? "denied" : "ok";
	}

	// (c) config-root addressing: seed INTO the scoped root, then check both
	// roots. The default-root read is static-only (no Claude Code spawn).
	const scopedRoot = mkdtempSync(join(tmpdir(), "claude-sdk-oauth-config-root-"));
	process.once("exit", () => {
		try {
			rmSync(scopedRoot, { recursive: true, force: true });
		} catch {}
	});
	const scopedSeed = await runChild({
		access: primary.credential.access,
		configDir: scopedRoot,
		prompts: [TOKEN_PROMPT(token)],
	});
	if (scopedSeed.error) reject(scopedSeed.error);
	if (!scopedSeed.sessionId) reject("session_id_absent");
	const defaultRead = await runChild({
		access: primary.credential.access,
		staticRead: scopedSeed.sessionId,
		staticOnly: true,
	});
	if (defaultRead.error) reject(defaultRead.error);
	const scoped = await runChild({
		access: primary.credential.access,
		configDir: scopedRoot,
		staticRead: scopedSeed.sessionId,
		resume: scopedSeed.sessionId,
		prompts: ["Repeat the token I gave you at the start, prefixed with RECALL."],
		expectToken: token,
	});
	const scopedFound = !scoped.error && scoped.staticFound !== false && scoped.coherent === true;
	let configRoot;
	if (defaultRead.staticFound === true) {
		// Visible under the default root: the SDK ignored CLAUDE_CONFIG_DIR.
		configRoot = "default-only";
	} else if (scopedFound) {
		configRoot = "env-honored";
	} else {
		reject("config_root_unaddressable");
	}

	console.log(
		`ACCEPTED resume=ok cache_read_ratio=${ratio} cross_account=${safeSignal(crossAccount)} config_root=${configRoot}`,
	);
	process.exit(0);
}
