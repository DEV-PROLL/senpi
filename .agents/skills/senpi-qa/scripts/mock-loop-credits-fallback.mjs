/**
 * Channel 3 proof: an Anthropic credits_required 429 takes the billing fast path.
 *
 * The fake server answers every primary-model /messages request with the
 * verbatim 429 SSE error captured from incident session 019fac55 (2026-07-29,
 * anthropic claude-fable-5): rate_limit_error carrying error_code
 * credits_required ("Usage credits are required for this model."). Pre-fix the
 * real CLI burned the whole same-model retry budget on the dead account
 * (1 + maxRetries requests), fell back as "transient", and let cooldown-expiry
 * revert into the dead model. Post-fix the CLI classifies the error as
 * non-retryable billing: exactly ONE primary request, an immediate pinned
 * fallback (fallback.log records reason "billing"), and the fallback model
 * streams the final marker.
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	runCli,
} from "./lib/common.mjs";
import {
	API_PRESETS,
	checkRealAuthUnchanged,
	hermeticEnv,
	writeMockModelsJson,
} from "./lib/mock-loop-support.mjs";

const FINAL_MARKER = "SENPI-QA-CREDITS-FALLBACK-RECOVERED-51d3";
const EVIDENCE_SLUG = "credits-required-billing-fallback";
const FALLBACK_MODEL_ID = "mock-model-fallback";

// Verbatim wire shape from incident session 019fac55 (2026-07-29).
const CREDITS_REQUIRED_SSE = `event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for this model.","details":{"error_code":"credits_required","disabled_reason":"out_of_credits","model":"mock-claude","model_display_name":"Mock Claude"}},"request_id":"req_mock_credits_required"}\n\n`;

function anthropicSseText(model, text) {
	const message = {
		id: "msg_mock_credits",
		type: "message",
		role: "assistant",
		model,
		content: [{ type: "text", text }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: { input_tokens: 12, output_tokens: 4 },
	};
	return [
		`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...message, content: [], stop_reason: null } })}\n`,
		`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n`,
		`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n`,
		`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } })}\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
	].join("\n");
}

function startServer() {
	const requests = [];
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			let model = "unknown";
			try {
				model = JSON.parse(body).model ?? "unknown";
			} catch {}
			requests.push({ url: request.url, model });
			if (model !== FALLBACK_MODEL_ID) {
				response.writeHead(429, { "content-type": "text/event-stream" });
				response.end(CREDITS_REQUIRED_SSE);
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(anthropicSseText(FALLBACK_MODEL_ID, FINAL_MARKER));
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Failed to resolve fake server port"));
				return;
			}
			resolve({
				origin: `http://127.0.0.1:${address.port}`,
				port: address.port,
				requests,
				stop: () => new Promise((done) => server.close(done)),
			});
		});
	});
}

function readFallbackLog(agentDir) {
	try {
		return readFileSync(join(agentDir, "logs", "fallback.log"), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return { event: "unparsed", raw: line };
				}
			});
	} catch {
		return [];
	}
}

async function main() {
	installCleanupHooks();
	const checks = createChecks("mock-loop-credits-fallback.mjs");
	const guard = guardRealAuth();
	const box = makeSandbox("mock-loop-credits-fallback");
	const server = await startServer();
	try {
		const preset = API_PRESETS["anthropic-messages"];
		writeMockModelsJson(box.agentDir, server, "anthropic-messages", {}, { models: [{ id: FALLBACK_MODEL_ID }] });
		writeFileSync(
			join(box.agentDir, "settings.json"),
			JSON.stringify(
				{
					retry: {
						enabled: true,
						maxRetries: 3,
						baseDelayMs: 1,
						provider: { maxRetries: 0, maxRetryDelayMs: 60000 },
						fallbackChains: {
							[`${preset.provider}/${preset.modelId}`]: [`${preset.provider}/${FALLBACK_MODEL_ID}`],
						},
					},
				},
				null,
				2,
			),
		);
		const startedAt = Date.now();
		const result = await runCli(
			[
				"--provider",
				preset.provider,
				"--model",
				preset.modelId,
				"--no-context-files",
				"--no-extensions",
				"--print",
				`Return ${FINAL_MARKER} after the provider recovers.`,
			],
			{ env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs: 60000 },
		);
		const elapsedMs = Date.now() - startedAt;
		const combined = `${result.stdout}\n${result.stderr}`;
		const markerCount = combined.split(FINAL_MARKER).length - 1;
		const primaryRequests = server.requests.filter((request) => request.model === preset.modelId).length;
		const fallbackRequests = server.requests.filter((request) => request.model === FALLBACK_MODEL_ID).length;
		const applied = readFallbackLog(box.agentDir).filter((entry) => entry.event === "fallback_applied");
		const billingApplied = applied.filter((entry) => entry.reason === "billing");
		checks.ok(
			"credits_required 429 falls back on the billing fast path through the real CLI",
			result.code === 0 &&
				!result.timedOut &&
				markerCount >= 1 &&
				primaryRequests === 1 &&
				fallbackRequests === 1 &&
				billingApplied.length === 1 &&
				elapsedMs < 45000,
			`code=${result.code} marker=${markerCount} primary=${primaryRequests} fallback=${fallbackRequests} applied=${JSON.stringify(applied)} elapsedMs=${elapsedMs}`,
		);
		checkRealAuthUnchanged(checks, guard);
		const dir = evidenceDir(EVIDENCE_SLUG);
		writeFileSync(join(dir, "credits-fallback-stdout.txt"), result.stdout);
		writeFileSync(join(dir, "credits-fallback-stderr.txt"), result.stderr);
		writeFileSync(
			join(dir, "credits-fallback-summary.json"),
			`${JSON.stringify(
				{
					command: "node .agents/skills/senpi-qa/scripts/mock-loop-credits-fallback.mjs",
					exitCode: result.code,
					timedOut: result.timedOut,
					elapsedMs,
					serverPort: server.port,
					requests: server.requests,
					fallbackLog: applied,
					finalMarkerCount: markerCount,
				},
				null,
				2,
			)}\n`,
		);
		process.exitCode = checks.finish() ? 0 : 1;
	} finally {
		await server.stop();
		box.cleanup();
	}
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
