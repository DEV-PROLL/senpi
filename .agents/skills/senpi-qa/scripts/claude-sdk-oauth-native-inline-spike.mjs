#!/usr/bin/env node
/**
 * Live spike: in-session mechanisms of one resident streaming-input query
 * (Wave A todo 2).
 *
 * One query, four turns:
 *   turn 1  normal exchange, records the system/init session_id + capabilities
 *   setModel(<other claude model>) between turns
 *   turn 2  asserts the SAME session_id and that the response model changed
 *   turn 3  interrupted mid-flight; the interrupt receipt shape is recorded
 *           (still_queued present => interrupt_receipt_v1, undefined => legacy)
 *   turn 4  continuation on the SAME query; coherence is proven by the model
 *           recalling the turn-1 token
 *
 * Usage:
 *   SENPI_LIVE_CLAUDE_SDK_OAUTH=1 SENPI_CODING_AGENT_DIR=<sandbox> \
 *     node .agents/skills/senpi-qa/scripts/claude-sdk-oauth-native-inline-spike.mjs
 *
 * Outcomes (final line):
 *   exit 0 "ACCEPTED setmodel=<ok|absent> interrupt_receipt=<v1|legacy> continue=<coherent|degraded>"
 *   exit 2 "REJECTED signal=<sanitized>"
 * Never prints token material.
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

const FIRST_MODEL = "claude-haiku-4-5";
const SECOND_MODEL = "claude-sonnet-4-5";
const MEMORY_TOKEN = `SPIKE_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

const { query } = await importClaudeSdk();
const input = controlledInput(
	userMessage(`Remember this token for later: ${MEMORY_TOKEN}. Reply with exactly: ACK`, randomUUID()),
);

const stream = query({
	prompt: input,
	options: {
		model: FIRST_MODEL,
		tools: [],
		permissionMode: "dontAsk",
		settingSources: [],
		includePartialMessages: true,
		systemPrompt: "Answer briefly. Obey the exact reply format the user asks for.",
		pathToClaudeCodeExecutable: claudeExecutable(),
		env: managedEnvironment(loaded.credential.access),
	},
});

const state = {
	sessionIds: new Set(),
	models: [],
	interruptReceipt: "legacy",
	interruptError: null,
	setModelError: false,
	pendingInterruptResult: false,
	coherent: false,
	failure: null,
	turn: 1,
};
let resolveDone;
const done = new Promise((resolve) => {
	resolveDone = resolve;
});

function recordModel(message) {
	if (message.type === "assistant" && typeof message.message?.model === "string") {
		state.models[state.turn] = message.message.model;
	}
}

async function interruptTurn3() {
	try {
		const receipt = await stream.interrupt();
		state.interruptReceipt = receipt && Array.isArray(receipt.still_queued) ? "v1" : "legacy";
	} catch (error) {
		state.interruptReceipt = "legacy";
		state.interruptError = error instanceof Error ? error.message : String(error);
	}
	state.turn = 4;
	state.pendingInterruptResult = true;
	input.push(
		userMessage(
			"Stop counting. Repeat the token I asked you to remember at the very start, prefixed with RECALL.",
			randomUUID(),
		),
	);
}

async function consume() {
	for await (const message of stream) {
		if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
			state.sessionIds.add(message.session_id);
		}
		if (message.type === "assistant") {
			recordModel(message);
			if (message.error) state.failure ??= "assistant_error";
			if (message.message?.model === "<synthetic>") state.failure ??= "synthetic_assistant";
			if (state.turn === 3) {
				await interruptTurn3();
				continue;
			}
			if (state.turn === 4 && assistantText(message).includes(MEMORY_TOKEN)) state.coherent = true;
		}
		if (message.type === "auth_status" && message.error) state.failure ??= "authentication_failed";
		if (message.type !== "result") continue;
		// A 401/refusal arrives as subtype:"success" with is_error:true, so both
		// fields gate the turn. The interrupted turn's own terminal result is
		// expected to be non-success and is consumed once.
		const interrupted = state.pendingInterruptResult;
		state.pendingInterruptResult = false;
		if ((message.subtype !== "success" || message.is_error === true) && !interrupted) {
			state.failure ??= message.subtype ?? message.terminal_reason ?? "result_error";
			break;
		}
		if (state.turn === 1) {
			try {
				await stream.setModel(SECOND_MODEL);
			} catch {
				state.setModelError = true;
			}
			state.turn = 2;
			input.push(userMessage("Reply with exactly: SECOND", randomUUID()));
			continue;
		}
		if (state.turn === 2) {
			state.turn = 3;
			input.push(
				userMessage("Count slowly from 1 to 40, one number per line, no other text.", randomUUID()),
			);
			continue;
		}
		if (state.turn === 4 && !interrupted) break;
	}
	resolveDone();
}

let outcome = null;
try {
	void consume();
	await withDeadline(done, "spike", 240_000);
} catch (error) {
	outcome = error instanceof Error ? error.message : String(error);
} finally {
	input.close();
	closeQuietly(stream);
}

if (outcome) reject(outcome);
if (state.failure) reject(state.failure);
if (state.sessionIds.size !== 1) reject("session_lineage_split");

const setModel =
	state.setModelError || state.models[2] === undefined
		? "absent"
		: state.models[2] !== state.models[1]
			? "ok"
			: "absent";
const continueOutcome = state.coherent ? "coherent" : "degraded";
console.log(
	`ACCEPTED setmodel=${setModel} interrupt_receipt=${state.interruptReceipt} continue=${continueOutcome}`,
);
process.exit(0);
