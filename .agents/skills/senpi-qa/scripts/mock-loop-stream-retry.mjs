/**
 * Channel 3 proof for an OpenAI-compatible SSE error before the first chunk.
 *
 * The first request returns a protocol-level `event: error` carrying the exact
 * DigitalOcean message. The second request returns one successful completion.
 * The real source CLI must retry inside the provider adapter and print exactly
 * one final marker.
 */

import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
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

const ERROR_MESSAGE = "Upstream error from DigitalOcean: stream failed";
const FINAL_MARKER = "SENPI-QA-DIGITALOCEAN-STREAM-RECOVERED-7a4f";
const EVIDENCE_SLUG = "digitalocean-stream-retry";

function startServer() {
	const requests = [];
	let attempts = 0;
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			attempts++;
			requests.push({
				attempt: attempts,
				url: request.url,
				body: Buffer.concat(chunks).toString("utf8"),
			});
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			if (attempts === 1) {
				response.end(`event: error\ndata: ${JSON.stringify({ error: { message: ERROR_MESSAGE, type: "server_error" } })}\n\n`);
				return;
			}
			const base = {
				id: "chatcmpl-digitalocean-retry",
				object: "chat.completion.chunk",
				created: 0,
				model: API_PRESETS["openai-completions"].modelId,
			};
			const send = (delta, finishReason = null) => {
				response.write(
					`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
				);
			};
			send({ role: "assistant", content: "" });
			send({ content: FINAL_MARKER });
			send({}, "stop");
			response.write(
				`data: ${JSON.stringify({
					...base,
					choices: [],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				})}\n\n`,
			);
			response.end("data: [DONE]\n\n");
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
			const origin = `http://127.0.0.1:${address.port}`;
			resolve({
				url: `${origin}/v1`,
				origin,
				port: address.port,
				requests,
				stop: () => new Promise((done) => server.close(done)),
			});
		});
	});
}

async function main() {
	installCleanupHooks();
	const checks = createChecks("mock-loop-stream-retry.mjs");
	const guard = guardRealAuth();
	const box = makeSandbox("mock-loop-digitalocean-stream-retry");
	const server = await startServer();
	try {
		writeMockModelsJson(box.agentDir, server, "openai-completions", {}, {
			retry: {
				enabled: false,
				maxRetries: 0,
				baseDelayMs: 0,
				provider: { maxRetries: 1, maxRetryDelayMs: 60000 },
			},
		});
		const preset = API_PRESETS["openai-completions"];
		const result = await runCli(
			[
				"--provider",
				preset.provider,
				"--model",
				preset.modelId,
				"--no-context-files",
				"--no-extensions",
				"--print",
				`Return ${FINAL_MARKER} after the transient stream error.`,
			],
			{ env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs: 60000 },
		);
		const combined = `${result.stdout}\n${result.stderr}`;
		const finalCount = combined.split(FINAL_MARKER).length - 1;
		const pass = result.code === 0 && !result.timedOut && server.requests.length === 2 && finalCount === 1;
		checks.ok(
			"real CLI retries the literal pre-output stream failure exactly once",
			pass,
			`code=${result.code} requests=${server.requests.length} finalCount=${finalCount}`,
		);
		checkRealAuthUnchanged(checks, guard);
		const dir = evidenceDir(EVIDENCE_SLUG);
		writeFileSync(join(dir, "mock-loop-stream-retry-stdout.txt"), result.stdout);
		writeFileSync(join(dir, "mock-loop-stream-retry-stderr.txt"), result.stderr);
		writeFileSync(
			join(dir, "mock-loop-stream-retry-summary.json"),
			`${JSON.stringify(
				{
					command: "node .agents/skills/senpi-qa/scripts/mock-loop-stream-retry.mjs",
					literalError: ERROR_MESSAGE,
					exitCode: result.code,
					timedOut: result.timedOut,
					serverPort: server.port,
					sandboxDir: box.dir,
					requests: server.requests.length,
					finalMarkerCount: finalCount,
					pass,
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
