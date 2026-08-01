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
 * (c) config-root addressing: getSessionInfo/getSessionMessages + a resume are
 *     run from an env-scoped CHILD with CLAUDE_CONFIG_DIR=<non-default root>,
 *     because the static-API option types expose no config-root parameter.
 *
 * Usage:
 *   SENPI_LIVE_CLAUDE_SDK_OAUTH=1 SENPI_CODING_AGENT_DIR=<sandbox> \
 *     node .agents/skills/senpi-qa/scripts/claude-sdk-oauth-reattach-spike.mjs
 *
 * Outcomes (final line):
 *   exit 0 "ACCEPTED resume=<ok> cache_read_ratio=<r> cross_account=<ok|denied> config_root=<env-honored|default-only>"
 *   exit 2 "REJECTED signal=<sanitized>"   (e.g. resume_not_found)
 * Never prints token material.
 */
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	loadCredential,
	reject,
	requireLiveGate,
	requireSandbox,
	safeSignal,
	withDeadline,
} from "./lib/claude-sdk-oauth-spike-support.mjs";
import { runTurns, TOKEN_PROMPT } from "./lib/claude-sdk-oauth-reattach-worker.mjs";

const WORKER_FLAG = "--reattach-worker";
const SELF = fileURLToPath(import.meta.url);

if (process.argv.includes(WORKER_FLAG)) {
	const request = JSON.parse(process.env.SENPI_REATTACH_WORKER_REQUEST ?? "{}");
	const result = await runTurns(request).catch((error) => ({
		error: error instanceof Error ? error.message : String(error),
	}));
	process.send?.(result, () => process.exit(0));
} else {
	requireLiveGate();
	const sandbox = requireSandbox();
	const primary = loadCredential(sandbox);
	if (primary.error) reject(primary.error);
	const secondary = loadCredential(sandbox, "claude-sdk-oauth-spike-b");
	const token = `REATTACH_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

	const runChild = (request) =>
		withDeadline(
			new Promise((resolve, rejectRun) => {
				const child = fork(SELF, [WORKER_FLAG], {
					env: { ...process.env, SENPI_REATTACH_WORKER_REQUEST: JSON.stringify(request) },
					silent: true,
				});
				let received;
				child.once("message", (message) => {
					received = message;
				});
				child.once("error", rejectRun);
				child.once("exit", (code, signal) =>
					received ? resolve(received) : rejectRun(new Error(`worker_${signal ?? code ?? "exit"}`)),
				);
			}),
			"worker",
			240_000,
		);

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

	// (b) cross-account resume under the same config root.
	let crossAccount = "unseeded";
	if (!secondary.error) {
		const crossed = await runChild({
			access: secondary.credential.access,
			resume: seeded.sessionId,
			prompts: ["Repeat the token I gave you at the start, prefixed with RECALL."],
			expectToken: token,
		});
		crossAccount = crossed.error || !crossed.coherent ? "denied" : "ok";
	}

	// (c) config-root addressing through an env-scoped child.
	const scopedRoot = mkdtempSync(join(tmpdir(), "claude-sdk-oauth-config-root-"));
	const scoped = await runChild({
		access: primary.credential.access,
		configDir: scopedRoot,
		staticRead: seeded.sessionId,
		resume: seeded.sessionId,
		prompts: ["Reply with exactly: SCOPED"],
	});
	const configRoot = scoped.error || scoped.staticFound === false ? "default-only" : "env-honored";

	console.log(
		`ACCEPTED resume=ok cache_read_ratio=${ratio} cross_account=${safeSignal(crossAccount)} config_root=${configRoot}`,
	);
	process.exit(0);
}
