#!/usr/bin/env node
/**
 * Live spike: native auto-compaction on a streaming-input query (Wave A todo 4).
 *
 * Drives ONE resident streaming-input query whose `autoCompactWindow` is shrunk
 * through the inline settings surface (Options.settings, sdk.d.ts:1875 ->
 * Settings.autoCompactWindow, sdk.d.ts:6325) so compaction triggers cheaply, and
 * records:
 *   - which switch actually enabled auto-compaction (settings key vs default-on
 *     with `settingSources: []`, which is what senpi's options.ts uses today),
 *   - the `compact_boundary` system message as received through the iterator,
 *   - post-compaction session-id stability + turn coherence,
 *   - whether a `/compact` user message sent through the streaming input
 *     triggers compaction (the manual fallback channel for todo 13).
 * extraArgs is CLI-flags-only (sdk.d.ts:1463-1468) and is deliberately NOT probed.
 *
 * Usage:
 *   SENPI_LIVE_CLAUDE_SDK_OAUTH=1 SENPI_CODING_AGENT_DIR=<sandbox> \
 *     node .agents/skills/senpi-qa/scripts/claude-sdk-oauth-autocompact-spike.mjs
 *
 * Outcomes (final line):
 *   exit 0 "ACCEPTED autocompact=<default-on|settings:autoCompactWindow|absent> boundary=<received|absent> manual_compact=<slash-ok|absent>"
 *   exit 2 "REJECTED signal=<sanitized>"
 * Never prints token material. Bounded to ~2 compaction cycles of quota.
 */
import { randomUUID } from "node:crypto";
import {
	assistantText,
	claudeExecutable,
	closeQuietly,
	controlledInput,
	importClaudeSdk,
	loadCredential,
	managedEnvironment,
	reject,
	requireLiveGate,
	requireSandbox,
	userMessage,
	withDeadline,
} from "./lib/claude-sdk-oauth-spike-support.mjs";

requireLiveGate();
const sandbox = requireSandbox();
const loaded = loadCredential(sandbox);
if (loaded.error) reject(loaded.error);

const AUTO_COMPACT_WINDOW = 4_000;
const MAX_FILLER_TURNS = 12;
const MEMORY_TOKEN = `COMPACT_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const FILLER = "Summarize this instruction back to me in one sentence: ".concat("context filler. ".repeat(60));

const { query } = await importClaudeSdk();
const input = controlledInput(
	userMessage(`Remember this token for later: ${MEMORY_TOKEN}. Reply with exactly: ACK`, randomUUID()),
);
const stream = query({
	prompt: input,
	options: {
		model: "claude-haiku-4-5",
		tools: [],
		permissionMode: "dontAsk",
		settingSources: [],
		systemPrompt: "Answer briefly. Obey the exact reply format the user asks for.",
		settings: { autoCompactWindow: AUTO_COMPACT_WINDOW, autoCompactEnabled: true },
		pathToClaudeCodeExecutable: claudeExecutable(),
		env: managedEnvironment(loaded.credential.access),
	},
});

const state = {
	sessionIds: new Set(),
	boundaries: [],
	autoBoundaryTurn: null,
	manualBoundary: false,
	coherent: false,
	failure: null,
	turn: 0,
	phase: "auto",
};
let resolveDone;
const done = new Promise((resolve) => {
	resolveDone = resolve;
});

function nextAutoPrompt() {
	if (state.autoBoundaryTurn !== null) {
		state.phase = "recall";
		return "Repeat the token I gave you at the very start, prefixed with RECALL.";
	}
	if (state.turn >= MAX_FILLER_TURNS) {
		state.phase = "manual";
		return "/compact";
	}
	return FILLER;
}

async function consume() {
	for await (const message of stream) {
		if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
			state.sessionIds.add(message.session_id);
		}
		if (message.type === "system" && message.subtype === "compact_boundary") {
			state.boundaries.push({
				trigger: message.compact_metadata?.trigger ?? "unknown",
				preTokens: message.compact_metadata?.pre_tokens ?? null,
				postTokens: message.compact_metadata?.post_tokens ?? null,
				phase: state.phase,
			});
			if (state.phase === "manual") state.manualBoundary = true;
			else state.autoBoundaryTurn ??= state.turn;
		}
		if (message.type === "assistant") {
			if (message.error) state.failure ??= "assistant_error";
			if (message.message?.model === "<synthetic>") state.failure ??= "synthetic_assistant";
			if (state.phase === "recall" && assistantText(message).includes(MEMORY_TOKEN)) state.coherent = true;
		}
		if (message.type === "auth_status" && message.error) state.failure ??= "authentication_failed";
		if (message.type !== "result") continue;
		// A 401/refusal arrives as subtype:"success" with is_error:true.
		if (message.subtype !== "success" || message.is_error === true) {
			state.failure ??= message.subtype ?? message.terminal_reason ?? "result_error";
			break;
		}
		state.turn += 1;
		if (state.phase === "recall") break;
		if (state.phase === "manual" && state.turn > MAX_FILLER_TURNS + 1) {
			state.phase = "recall";
			input.push(
				userMessage("Repeat the token I gave you at the very start, prefixed with RECALL.", randomUUID()),
			);
			continue;
		}
		input.push(userMessage(nextAutoPrompt(), randomUUID()));
	}
	resolveDone();
}

let outcome = null;
try {
	void consume();
	await withDeadline(done, "spike", 600_000);
} catch (error) {
	outcome = error instanceof Error ? error.message : String(error);
} finally {
	input.close();
	closeQuietly(stream);
}

if (outcome) reject(outcome);
if (state.failure) reject(state.failure);
if (state.sessionIds.size !== 1) reject("session_lineage_split");

const autoBoundary = state.boundaries.find((boundary) => boundary.phase !== "manual");
const autocompact = autoBoundary
	? autoBoundary.trigger === "auto"
		? "settings:autoCompactWindow"
		: "default-on"
	: "absent";
const boundary = state.boundaries.length > 0 ? "received" : "absent";
const manual = state.manualBoundary ? "slash-ok" : "absent";
process.stdout.write(
	`boundaries=${JSON.stringify(state.boundaries)} turns=${state.turn} coherent=${state.coherent}\n`,
);
console.log(`ACCEPTED autocompact=${autocompact} boundary=${boundary} manual_compact=${manual}`);
process.exit(0);
