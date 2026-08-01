#!/usr/bin/env node
/**
 * Full-stack continuity probe for the claude-sdk-oauth lane.
 *
 * Unlike claude-sdk-oauth-registry-probe.mjs (which drives the registry APIs
 * directly), this probe drives the REAL stack: createAgentSession() ->
 * AgentSession.prompt() -> provider streamSimple -> resident session registry
 * or the flattened <conversation_history> path. SDK query creation is
 * intercepted at overrideSdkBoundary — the single choke point BOTH paths share
 * (session-registry.ts queryFactory for the resident path, stream.ts for the
 * non-resident flatten path) — so every query, its lineage, and every submitted
 * user payload is measured on the real code path.
 *
 * The Claude Code subprocess is real; its Anthropic traffic is pinned to a
 * loopback-only SSE server via ANTHROPIC_BASE_URL, so no credentials and no
 * network egress are involved.
 *
 * Run with:
 *   node .agents/skills/senpi-qa/scripts/claude-sdk-oauth-fullstack-probe.mjs --baseline
 *
 * Modes:
 *   --baseline  always exits 0 — the per-turn table IS the deliverable
 *   (default)   gate mode: VERDICT FAIL exits 1
 * Exit 2 is reserved for probe-infrastructure failures (e.g. loopback down).
 */

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { guardRealAuth, installCleanupHooks, makeSandbox, repoRoot, track } from "./lib/common.mjs";
import {
	classifyPayload,
	formatTurnTable,
	loopbackSseBody,
	safeDetail,
	seedProbeAgentDir,
	withTimeout,
} from "./lib/claude-sdk-oauth-fullstack-support.mjs";
import { stripCredentialEnvironment } from "./lib/claude-sdk-oauth-spike-support.mjs";

const ROOT = repoRoot();
const INNER_FLAG = "SENPI_CLAUDE_SDK_FULLSTACK_PROBE_INNER";
const BASELINE = process.argv.includes("--baseline");
const TURNS = 6;
const MODEL_ID = "claude-haiku-4-5";

if (process.env[INNER_FLAG] !== "1") {
	const child = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, ...process.argv.slice(2)], {
		cwd: ROOT,
		env: { ...process.env, [INNER_FLAG]: "1" },
		stdio: "inherit",
	});
	if (child.error) {
		process.stderr.write(`probe launcher failed: ${child.error.message}\n`);
		process.exit(2);
	}
	process.exit(child.status ?? 2);
}

installCleanupHooks();

const authGuard = guardRealAuth();
const box = makeSandbox("claude-sdk-fullstack-probe");
const providerRequests = [];
let server;
let session;
let fatal;
let infrastructureFailure;

const turns = [];
const creations = [];
let currentTurn = null;

try {
	server = track(
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
					body = { messages: [] };
				}
				// Buffer.byteLength, not raw.length: the column is labeled bytes, and
				// raw.length counts UTF-16 code units, not HTTP body bytes.
				providerRequests.push({
					bytes: Buffer.byteLength(raw, "utf8"),
					messages: Array.isArray(body.messages) ? body.messages.length : 0,
				});
				response.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				response.end(loopbackSseBody(`probe-reply-${providerRequests.length}`, providerRequests.length));
			});
		}),
	);
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
		throw new Error("probe server did not bind exclusively to 127.0.0.1");
	}
	const baseUrl = `http://127.0.0.1:${address.port}`;

	seedProbeAgentDir(box.agentDir);
	// Hermetic no-credentials contract: ambient Anthropic/OAuth credential and
	// custom-header channels (inherited from the operator's shell) would
	// otherwise be sent to the loopback capture server. ANTHROPIC_API_KEY and
	// ANTHROPIC_BASE_URL are pinned to dummy loopback values below; every other
	// credential channel is stripped first. The probe re-adds exactly the
	// SENPI_* surface it needs in the assignment that follows.
	stripCredentialEnvironment(process.env);
	Object.assign(process.env, {
		HOME: box.dir,
		USERPROFILE: box.dir,
		TMPDIR: box.dir,
		SENPI_CODING_AGENT_DIR: box.agentDir,
		SENPI_CODING_AGENT_SESSION_DIR: box.sessionDir,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		ANTHROPIC_BASE_URL: baseUrl,
		ANTHROPIC_API_KEY: "fullstack-probe-dummy-key",
		CLAUDE_CONFIG_DIR: join(box.dir, "claude-config"),
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		CLAUDE_CODE_DISABLE_TELEMETRY: "1",
		SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION: "ambient",
		NO_PROXY: "127.0.0.1,localhost",
		no_proxy: "127.0.0.1,localhost",
	});

	const sourceRoot = join(ROOT, "packages", "coding-agent", "src");
	const boundaryModule = await import(
		pathToFileURL(join(sourceRoot, "core", "extensions", "builtin", "claude-sdk-oauth", "sdk-boundary.ts")).href
	);
	const baseQuery = boundaryModule.getSdkBoundary().query;
	boundaryModule.overrideSdkBoundary({
		query: (input) => {
			const options = input.options ?? {};
			// The resident registry always creates its query with an explicit
			// sessionId plus the replay-user-messages extraArg (session-registry.ts);
			// the non-resident flatten branch in stream.ts never does either.
			const resident =
				typeof options.sessionId === "string" &&
				options.extraArgs !== undefined &&
				"replay-user-messages" in options.extraArgs;
			const record = {
				index: creations.length + 1,
				path: resident ? "resident-registry" : "flatten-stream",
				sessionId: options.sessionId ?? null,
				resume: options.resume ?? null,
				forked: options.forkSession === true,
				payloads: [],
			};
			creations.push(record);
			const prompt = input.prompt;
			if (typeof prompt === "string") return baseQuery(input);
			const observed = (async function* () {
				for await (const message of prompt) {
					record.payloads.push(message);
					if (currentTurn) currentTurn.payloads.push({ creation: record.index, path: record.path, message });
					yield message;
				}
			})();
			return baseQuery({ ...input, prompt: observed });
		},
	});

	const { createAgentSession } = await import(pathToFileURL(join(sourceRoot, "index.ts")).href);
	const created = await createAgentSession({
		cwd: box.cwd,
		agentDir: box.agentDir,
		noTools: "all",
		autoTitleSessions: false,
	});
	session = created.session;
	const model = session.modelRuntime.getModel("claude-sdk-oauth", MODEL_ID);
	if (!model) throw new Error("claude-sdk-oauth provider did not register its models");
	await session.setModel(model);

	for (let index = 1; index <= TURNS; index++) {
		const creationsBefore = creations.length;
		const requestsBefore = providerRequests.length;
		currentTurn = { index, payloads: [] };
		await withTimeout(
			session.prompt(`Turn ${index}: reply with TOKEN_T${index}.`, { sessionTitlePrompt: false }),
			`turn ${index}`,
			120_000,
		);
		const newQueries = creations.slice(creationsBefore);
		const classified = currentTurn.payloads.map((entry) => classifyPayload(entry.message));
		turns.push({
			index,
			queries: newQueries.length,
			path: currentTurn.payloads.at(-1)?.path ?? newQueries.at(-1)?.path ?? "none",
			lineage: creations.at(-1)?.sessionId ?? "none",
			kind: classified.at(-1)?.kind ?? "none",
			bytes: classified.reduce((total, item) => total + item.bytes, 0),
			wireRequests: providerRequests.length - requestsBefore,
			wireBytes: providerRequests.slice(requestsBefore).reduce((total, item) => total + item.bytes, 0),
		});
		currentTurn = null;
	}
} catch (error) {
	fatal = error instanceof Error ? error : new Error(String(error));
	infrastructureFailure = /loopback|ECONNREFUSED|EADDRINUSE|EACCES|did not bind/i.test(fatal.message);
} finally {
	try {
		session?.dispose?.();
	} catch {}
	if (server) await new Promise((resolve) => server.close(resolve));
	try {
		authGuard.assertUnchanged();
	} catch (error) {
		fatal = error instanceof Error ? error : new Error(String(error));
	}
	box.cleanup();
}

if (infrastructureFailure) {
	process.stdout.write(`REJECTED signal=loopback_unreachable detail=${safeDetail(fatal.message)}\n`);
	process.exit(2);
}

process.stdout.write(formatTurnTable(turns));
const lineages = new Set(creations.map((record) => record.sessionId ?? "none"));
const flattenTurns = turns.filter((turn) => turn.kind === "flatten").length;
// Gate the ROUTE, not just the payload shape: a bootstrap payload on a
// non-resident (flatten-stream) query must not masquerade as resident-path.
const nonResidentTurns = turns.filter((turn) => turn.path !== "resident-registry").length;
const passed =
	!fatal &&
	turns.length === TURNS &&
	creations.length === 1 &&
	lineages.size === 1 &&
	flattenTurns === 0 &&
	nonResidentTurns === 0;
if (fatal) process.stderr.write(`PROBE ERROR: ${safeDetail(fatal.stack ?? fatal.message)}\n`);
process.stdout.write(
	`VERDICT: ${passed ? "PASS" : "FAIL"} fullstack-baseline queries=${creations.length} lineages=${lineages.size} flatten_turns=${flattenTurns} non_resident=${nonResidentTurns}\n`,
);
process.exit(BASELINE ? 0 : passed ? 0 : 1);
