#!/usr/bin/env node
/**
 * Real-surface probe: manual /compact on the claude-sdk-oauth lane with
 * `resumeMode: "off"` (senpi owns compaction) must complete.
 *
 * Drives the REAL stack — createAgentSession() -> AgentSession.compact() ->
 * compaction extension summarizer -> claude-sdk-oauth streamSimple -> the real
 * Claude Code subprocess — against a loopback Anthropic server. No credentials,
 * no network egress (ANTHROPIC_BASE_URL pinned to 127.0.0.1).
 *
 * Modes:
 *   --mode toolless    (default) the loopback answers a request that OFFERS tools
 *                      with a tool_use (the summarizer hijack) and a request
 *                      WITHOUT tools with the summary text. PASS = compaction
 *                      applied with that text (the lane honored toolChoice none).
 *   --mode always-tool the loopback answers EVERY compaction request with a
 *                      tool_use, so the summarizer can never produce text. PASS =
 *                      compaction still applied through the deterministic
 *                      fallback (details.origin === "required-compaction-recovery").
 *
 * Usage: bun .agents/skills/senpi-qa/scripts/claude-sdk-oauth-toolless-compact-probe.mjs [--mode toolless|always-tool] [--evidence <dir>]
 */

import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { guardRealAuth, installCleanupHooks, makeSandbox, repoRoot, track } from "./lib/common.mjs";
import { loopbackSseBody, seedProbeAgentDir } from "./lib/claude-sdk-oauth-fullstack-support.mjs";
import { applyHermeticEnvironment, assertHermeticEnvironment } from "./lib/claude-sdk-oauth-hermetic-env.mjs";
import { withTimeout } from "./lib/with-timeout.mjs";

const ROOT = repoRoot();
const MODEL_ID = "claude-haiku-4-5";
const SEED_TURNS = 6;
// Long USER turns (not replies) give the summarizer history beyond keepRecentTokens.
const SEED_FILLER = "context ".repeat(300);
const SUMMARY_TEXT = "PROBE_SUMMARY_OK: the conversation covered six token turns.";

const argv = process.argv.slice(2);
const modeArg = argv.indexOf("--mode");
const mode = modeArg === -1 ? "toolless" : argv[modeArg + 1];
const evidenceArg = argv.indexOf("--evidence");
const evidenceDir = evidenceArg === -1 ? undefined : argv[evidenceArg + 1];
if (mode !== "toolless" && mode !== "always-tool") {
	process.stdout.write(`REJECTED signal=bad_mode detail=${mode}\n`);
	process.exit(2);
}

installCleanupHooks();

function toolUseSseBody(toolName, sequence) {
	const input = JSON.stringify({ file_path: "/dev/null" });
	const events = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: `msg_toolless_probe_${sequence}`,
					type: "message",
					role: "assistant",
					model: MODEL_ID,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0 },
				},
			},
		],
		[
			"content_block_start",
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: `toolu_probe_${sequence}`, name: toolName, input: {} },
			},
		],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: input } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 8 } }],
		["message_stop", { type: "message_stop" }],
	];
	return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const requests = [];
let phase = "seed";

function startLoopbackServer() {
	return new Promise((resolve, reject) => {
		const server = track(
			createServer((request, response) => {
				if (request.method !== "POST") {
					response.writeHead(200);
					response.end();
					return;
				}
				let raw = "";
				request.setEncoding("utf8");
				request.on("data", (chunk) => {
					raw += chunk;
				});
				request.on("end", () => {
					let body;
					try {
						body = JSON.parse(raw);
					} catch {
						body = {};
					}
					const tools = Array.isArray(body.tools) ? body.tools : [];
					const sequence = requests.length + 1;
					const toolNames = tools.map((tool) => tool?.name).filter((name) => typeof name === "string");
					const entry = { sequence, phase, hasTools: tools.length > 0, toolCount: tools.length, toolNames: toolNames.slice(0, 12), bytes: raw.length, reply: "text" };
					let sse;
					if (phase === "compact" && (mode === "always-tool" || tools.length > 0)) {
						// The hijack: a summarizer that is OFFERED tools calls one. Pick an
						// offered tool when there is one so the CLI routes it through the
						// host-denial hook exactly as production would.
						const toolName = toolNames.find((name) => name === "Read") ?? toolNames[0] ?? "Read";
						entry.reply = `tool_use:${toolName}`;
						sse = toolUseSseBody(toolName, sequence);
					} else {
						sse = loopbackSseBody(phase === "compact" ? SUMMARY_TEXT : `TOKEN_T${sequence}`, sequence);
					}
					requests.push(entry);
					response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
					response.end(sse);
				});
			}),
		);
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
		});
	});
}

const authGuard = guardRealAuth();
const box = makeSandbox("claude-sdk-toolless-compact-probe");
let server;
let session;
let fatal;
let outcome = { compacted: false };
let closeSession;
try {
	({ server, baseUrl: box.baseUrl } = await startLoopbackServer());
	seedProbeAgentDir(box.agentDir);
	// Keep the retained tail tiny so six short turns leave history to summarize.
	writeFileSync(join(box.agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 400, reserveTokens: 1024 } }));
	const claudeConfigDir = join(box.dir, "claude-config");
	mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(claudeConfigDir, ".credentials.json"),
		JSON.stringify({
			claudeAiOauth: {
				accessToken: "toolless-probe-dummy-access",
				refreshToken: "toolless-probe-dummy-refresh",
				expiresAt: 4102444800000,
				scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
			},
		}),
		{ mode: 0o600 },
	);
	applyHermeticEnvironment(process.env, {
		HOME: box.dir,
		USERPROFILE: box.dir,
		TMPDIR: box.dir,
		SENPI_CODING_AGENT_DIR: box.agentDir,
		SENPI_CODING_AGENT_SESSION_DIR: box.sessionDir,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		ANTHROPIC_BASE_URL: box.baseUrl,
		ANTHROPIC_API_KEY: "toolless-probe-dummy-key",
		CLAUDE_CONFIG_DIR: claudeConfigDir,
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		CLAUDE_CODE_DISABLE_TELEMETRY: "1",
		SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION: "ambient",
		SENPI_CLAUDE_SDK_OAUTH_ENABLED: "1",
		// senpi owns compaction on this lane: every request flattens through the
		// non-resident path and the compaction extension stays fully active.
		SENPI_CLAUDE_SDK_OAUTH_RESUME: "off",
		NO_PROXY: "127.0.0.1,localhost",
		no_proxy: "127.0.0.1,localhost",
	});
	assertHermeticEnvironment(process.env, box.baseUrl);

	const sourceRoot = join(ROOT, "packages", "coding-agent", "src");
	({ closeSession } = await import(
		pathToFileURL(join(sourceRoot, "core", "extensions", "builtin", "claude-sdk-oauth", "session-registry.ts")).href
	));
	const { createAgentSession } = await import(pathToFileURL(join(sourceRoot, "index.ts")).href);
	// Default tools stay registered: production sessions offer tools to the
	// summarizer (anti-distillation shape), which is what the hijack retry gates on.
	const created = await createAgentSession({ cwd: box.cwd, agentDir: box.agentDir, autoTitleSessions: false });
	session = created.session;
	track({
		exitCode: null,
		kill: () => {
			try {
				if (session?.id) closeSession(session.id, "probe_shutdown");
			} catch {}
			session.dispose();
		},
	});
	const model = session.modelRuntime.getModel("claude-sdk-oauth", MODEL_ID);
	if (!model) throw new Error("claude-sdk-oauth provider did not register its models");
	await session.setModel(model);

	for (let index = 1; index <= SEED_TURNS; index += 1) {
		await withTimeout(session.prompt(`Turn ${index}: reply with TOKEN_T${index}. ${SEED_FILLER}`, { sessionTitlePrompt: false }), `seed turn ${index}`, 120_000);
	}
	const seedRequests = requests.length;

	phase = "compact";
	let compactError;
	let result;
	try {
		result = await withTimeout(session.compact(), "manual compaction", 180_000);
	} catch (error) {
		compactError = error instanceof Error ? error.message : String(error);
	}
	const branch = session.sessionManager.getBranch();
	const compactionEntry = [...branch].reverse().find((entry) => entry.type === "compaction");
	const compactRequests = requests.slice(seedRequests);
	outcome = {
		mode,
		seedRequests,
		compactRequests,
		compactError: compactError ?? null,
		resultSummaryHead: typeof result?.summary === "string" ? result.summary.slice(0, 120) : null,
		resultDetailsOrigin: result?.details?.origin ?? null,
		resultFailureKind: result?.details?.failureKind ?? null,
		compactionEntry: compactionEntry
			? { id: compactionEntry.id, summaryHead: String(compactionEntry.summary ?? "").slice(0, 120), detailsOrigin: compactionEntry.details?.origin ?? null }
			: null,
		compacted: compactionEntry !== undefined && compactError === undefined,
	};
} catch (error) {
	fatal = error instanceof Error ? error : new Error(String(error));
} finally {
	try {
		if (session?.id && closeSession) closeSession(session.id, "probe_shutdown");
	} catch {}
	try {
		session?.dispose?.();
	} catch {}
	if (server) await new Promise((resolve) => server.close(resolve));
	try {
		authGuard.assertUnchanged();
	} catch (error) {
		fatal = fatal ?? (error instanceof Error ? error : new Error(String(error)));
	}
	box.cleanup();
}

const infrastructureFailure =
	fatal !== undefined &&
	/loopback|ECONNREFUSED|EADDRINUSE|EACCES|did not bind|claude_binary_not_found|Native CLI binary.*not found|Claude native binary.*not found/i.test(fatal.message);

let verdict;
if (infrastructureFailure) {
	verdict = `REJECTED signal=loopback_unreachable detail=${fatal.message}`;
	process.exitCode = 2;
} else if (fatal) {
	verdict = `FAIL signal=probe_error detail=${fatal.message}`;
	process.exitCode = 1;
} else if (mode === "toolless") {
	const toolless = outcome.compactRequests.find((entry) => !entry.hasTools);
	const ok = outcome.compacted && toolless !== undefined && (outcome.compactionEntry?.summaryHead ?? "").includes("PROBE_SUMMARY_OK");
	verdict = ok
		? `PASS mode=toolless compactRequests=${outcome.compactRequests.length} toollessRequest=#${toolless.sequence} summary=${JSON.stringify(outcome.compactionEntry.summaryHead)}`
		: `FAIL mode=toolless compacted=${outcome.compacted} toollessRequest=${toolless ? `#${toolless.sequence}` : "none"} error=${JSON.stringify(outcome.compactError)} requests=${JSON.stringify(outcome.compactRequests.map((r) => `${r.sequence}:${r.hasTools ? `tools(${r.toolCount})` : "no-tools"}->${r.reply}`))}`;
	process.exitCode = ok ? 0 : 1;
} else {
	const ok = outcome.compacted && outcome.compactionEntry?.detailsOrigin === "required-compaction-recovery";
	verdict = ok
		? `PASS mode=always-tool compactRequests=${outcome.compactRequests.length} origin=${outcome.compactionEntry.detailsOrigin} failureKind=${outcome.resultFailureKind}`
		: `FAIL mode=always-tool compacted=${outcome.compacted} origin=${outcome.compactionEntry?.detailsOrigin ?? "none"} error=${JSON.stringify(outcome.compactError)} requests=${JSON.stringify(outcome.compactRequests.map((r) => `${r.sequence}:${r.hasTools ? `tools(${r.toolCount})` : "no-tools"}->${r.reply}`))}`;
	process.exitCode = ok ? 0 : 1;
}
process.stdout.write(`${verdict}\n`);
if (evidenceDir) {
	mkdirSync(evidenceDir, { recursive: true });
	writeFileSync(join(evidenceDir, `toolless-compact-${mode}.json`), JSON.stringify({ verdict, outcome, fatal: fatal?.message ?? null }, null, 2));
	process.stdout.write(`evidence=${join(evidenceDir, `toolless-compact-${mode}.json`)}\n`);
}
