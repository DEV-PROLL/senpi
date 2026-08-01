#!/usr/bin/env node
/**
 * Live spike: native auto-compaction on a streaming-input query (Wave A todo 4).
 *
 * Drives resident streaming-input queries whose `autoCompactWindow` is set to
 * the SMALLEST value SDK 0.3.220 accepts (100,000 tokens — the Settings schema
 * is `number().int().min(1e5).max(1e6).optional().catch(void 0)`, so anything
 * smaller is silently dropped and the arm would probe nothing) through the
 * inline settings surface (Options.settings, sdk.d.ts:1875 ->
 * Settings.autoCompactWindow, sdk.d.ts:6325), then overflows that window with a
 * single oversized filler message so auto-compaction cannot be skipped.
 *
 * TWO arms discriminate WHICH switch enables auto-compaction (the todo-4
 * question a single arm cannot answer — a boundary's trigger is "auto" either
 * way):
 *   arm A "keyed":   settings {autoCompactWindow, autoCompactEnabled: true}
 *   arm B "default": settings {autoCompactWindow} only — no enabled key
 * arm B producing an auto boundary means the window key alone suffices
 * (default-on under `settingSources: []`, which is what senpi's options.ts
 * uses); only arm A producing one means the explicit enabled key is required.
 *
 * Also records, per arm: the `compact_boundary` system message as received
 * through the iterator, and post-compaction session-id stability + turn
 * coherence. The manual `/compact` streaming-input fallback (todo 13) is
 * probed once, inside arm A, only when arm A produced no auto boundary.
 * extraArgs is CLI-flags-only (sdk.d.ts:1463-1468) and is deliberately NOT probed.
 *
 * Usage:
 *   SENPI_LIVE_CLAUDE_SDK_OAUTH=1 SENPI_CODING_AGENT_DIR=<sandbox> \
 *     node .agents/skills/senpi-qa/scripts/claude-sdk-oauth-autocompact-spike.mjs
 *
 * Outcomes (final line):
 *   exit 0 "ACCEPTED autocompact=<default-on|settings:autoCompactEnabled|absent> boundary=<received|absent> manual_compact=<slash-ok|absent>"
 *   exit 2 "REJECTED signal=<sanitized>"
 * Never prints token material. Bounded to two ~130k-token stimuli plus one
 * compaction cycle of quota (~2 compaction cycles, per the todo-4 budget).
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
	withTimeout,
} from "./lib/claude-sdk-oauth-spike-support.mjs";

requireLiveGate();
const sandbox = requireSandbox();
const loaded = loadCredential(sandbox);
if (loaded.error) reject(loaded.error);

// 100,000 is the minimum autoCompactWindow SDK 0.3.220 honors; the stimulus
// below is sized ~130k tokens (16 chars ~= 4 tokens) so one user message
// overflows the window and auto-compaction cannot be skipped.
const AUTO_COMPACT_WINDOW = 100_000;
const FILLER = "Summarize this instruction back to me in one sentence: ".concat("context filler. ".repeat(33_000));

function nextPrompt(state, probeManual) {
	// Turn 2 is the single oversized stimulus that overflows the 100k window.
	if (state.turn === 1) return FILLER;
	if (state.autoBoundaryTurn !== null || !probeManual || state.manualCompactSent) {
		state.phase = "recall";
		return `Repeat the token I gave you at the very start, prefixed with RECALL.`;
	}
	// Exactly ONE `/compact` may be sent: a second one would compact an
	// already-compacted transcript and make the manual_compact observation
	// unattributable to either send. The manual arm only runs when the
	// oversized stimulus produced no auto boundary.
	state.phase = "manual";
	state.manualCompactSent = true;
	return "/compact";
}

async function runArm({ settings, probeManual }) {
	const token = `COMPACT_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
	// Every reject path that can carry an SDK error string redacts the access
	// token and the generated recall token first — safeSignal is a shape
	// sanitizer, not a secret redactor.
	const secrets = [loaded.credential.access, token];
	// Setup runs inside the guarded path: an SDK import, a missing Claude binary
	// or a query-construction failure must exit through the sanitized REJECTED
	// contract, never as a raw stack trace on exit 1.
	let query;
	let input;
	let stream;
	try {
		({ query } = await importClaudeSdk());
		input = controlledInput(
			userMessage(`Remember this token for later: ${token}. Reply with exactly: ACK`, randomUUID()),
		);
		stream = query({
			prompt: input,
			options: {
				model: "claude-haiku-4-5",
				tools: [],
				permissionMode: "dontAsk",
				settingSources: [],
				systemPrompt: "Answer briefly. Obey the exact reply format the user asks for.",
				settings,
				pathToClaudeCodeExecutable: claudeExecutable(),
				env: managedEnvironment(loaded.credential.access),
			},
		});
	} catch (error) {
		reject(error instanceof Error ? error.message : String(error), "", secrets);
	}

	// Signal-aware cleanup: Ctrl-C/SIGTERM skips `finally`, so without a handler
	// the Claude Code subprocess would be orphaned mid-arm and keep burning
	// quota. Closing the query handle reaps the subprocess before exiting.
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.once(signal, () => {
			input.close();
			closeQuietly(stream);
			reject(`interrupted_${signal.toLowerCase()}`, "", secrets);
		});
	}

	const state = {
		sessionIds: new Set(),
		boundaries: [],
		autoBoundaryTurn: null,
		manualCompactSent: false,
		coherent: false,
		failure: null,
		turn: 0,
		phase: "auto",
	};
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
				if (state.phase !== "manual") state.autoBoundaryTurn ??= state.turn;
			}
			if (message.type === "assistant") {
				if (message.error) state.failure ??= "assistant_error";
				if (message.message?.model === "<synthetic>") state.failure ??= "synthetic_assistant";
				if (state.phase === "recall" && assistantText(message).includes(token)) state.coherent = true;
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
			// nextPrompt() owns the manual->recall transition, so the `/compact`
			// send happens in exactly one place.
			input.push(userMessage(nextPrompt(state, probeManual), randomUUID()));
		}
	}

	let outcome = null;
	try {
		// Await the consumer itself: a rejected consumer surfaces its real error
		// immediately, and withTimeout is what actually bounds a hang.
		await withTimeout(consume(), "spike", 600_000);
	} catch (error) {
		outcome = error instanceof Error ? error.message : String(error);
	} finally {
		input.close();
		closeQuietly(stream);
	}

	if (outcome) reject(outcome, "", secrets);
	if (state.failure) reject(state.failure, "", secrets);
	if (state.sessionIds.size !== 1) reject("session_lineage_split");
	return state;
}

const armA = await runArm({
	settings: { autoCompactWindow: AUTO_COMPACT_WINDOW, autoCompactEnabled: true },
	probeManual: true,
});
const armB = await runArm({
	settings: { autoCompactWindow: AUTO_COMPACT_WINDOW },
	probeManual: false,
});

// The verdict reads the SDK-provided compact_metadata.trigger, not the spike's
// own phase bookkeeping — a boundary's origin (native auto vs /compact) is what
// the arms measure. `unknown` (metadata absent) falls back to the phase.
const isAutoBoundary = (boundary) =>
	boundary.trigger === "unknown" ? boundary.phase !== "manual" : boundary.trigger === "auto";
const isManualBoundary = (boundary) =>
	boundary.trigger === "unknown" ? boundary.phase === "manual" : boundary.trigger === "manual";
const autoA = armA.boundaries.some(isAutoBoundary);
const autoB = armB.boundaries.some(isAutoBoundary);
// arm B (no enabled key) firing proves default-on; only arm A firing proves the
// explicit autoCompactEnabled key is required; neither means absent.
const autocompact = autoB ? "default-on" : autoA ? "settings:autoCompactEnabled" : "absent";
const boundary = autoA || autoB ? "received" : "absent";
const manual = armA.boundaries.some(isManualBoundary) ? "slash-ok" : "absent";
process.stdout.write(
	`armA boundaries=${JSON.stringify(armA.boundaries)} turns=${armA.turn} coherent=${armA.coherent}\n`,
);
process.stdout.write(
	`armB boundaries=${JSON.stringify(armB.boundaries)} turns=${armB.turn} coherent=${armB.coherent}\n`,
);
console.log(`ACCEPTED autocompact=${autocompact} boundary=${boundary} manual_compact=${manual}`);
process.exit(0);
