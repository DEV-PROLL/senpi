/**
 * Shared helpers for claude-sdk-oauth-fullstack-probe.mjs.
 *
 * Kept out of the probe so each script stays under the 250 pure-LOC ceiling.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Marker emitted by prompt-bridge.ts buildPromptBlocks when senpi flattens history. */
export const FLATTEN_MARKER = "<conversation_history>";
/** Trailer buildPromptBlocks always appends, even when there is no history yet. */
export const FLATTEN_TRAILER = "The above is the conversation history so far";

export function safeDetail(value) {
	return String(value)
		.replace(/[\r\n]+/g, " ")
		.slice(0, 500);
}

export function withTimeout(promise, label, timeoutMs = 60_000) {
	let timer;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function payloadText(message) {
	const content = message?.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && typeof block.text === "string" ? block.text : ""))
		.join("\n");
}

/**
 * Classify one submitted SDK user message:
 *   flatten   - carries a rebuilt <conversation_history> transcript
 *   bootstrap - buildPromptBlocks shape with no prior history (first turn)
 *   delta     - only the new user content (the resident-session happy path)
 */
export function classifyPayload(message) {
	const text = payloadText(message);
	const bytes = Buffer.byteLength(text, "utf8");
	if (text.includes(FLATTEN_MARKER)) return { kind: "flatten", bytes };
	if (text.includes(FLATTEN_TRAILER)) return { kind: "bootstrap", bytes };
	return { kind: "delta", bytes };
}

export function formatTurnTable(turns) {
	const header = ["turn", "queries", "path", "payload", "bytes", "wire_reqs", "wire_bytes", "lineage"];
	const rows = turns.map((turn) => [
		String(turn.index),
		String(turn.queries),
		turn.path,
		turn.kind,
		String(turn.bytes),
		String(turn.wireRequests),
		String(turn.wireBytes),
		String(turn.lineage).slice(0, 8),
	]);
	const widths = header.map((label, column) =>
		Math.max(label.length, ...rows.map((row) => row[column].length), 0),
	);
	const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
	return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line), ""].join("\n");
}

/** SSE body the loopback server returns for one Anthropic /v1/messages request. */
export function loopbackSseBody(text, sequence) {
	const events = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: `msg_fullstack_probe_${sequence}`,
					type: "message",
					role: "assistant",
					model: "claude-haiku-4-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0 },
				},
			},
		],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 2 },
			},
		],
		["message_stop", { type: "message_stop" }],
	];
	return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

/**
 * Seed the sandbox agent dir with a DUMMY claude-sdk-oauth credential so the
 * provider counts as configured. The token is never used: the Claude Code
 * subprocess talks only to the loopback server.
 */
export function seedProbeAgentDir(agentDir) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({
			"claude-sdk-oauth": {
				type: "oauth",
				access: "fullstack-probe-dummy-access",
				refresh: "fullstack-probe-dummy-refresh",
				expires: Date.now() + 3_600_000,
			},
		}),
		{ mode: 0o600 },
	);
}
