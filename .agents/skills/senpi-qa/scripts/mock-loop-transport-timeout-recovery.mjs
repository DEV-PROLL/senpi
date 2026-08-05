import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import {
	createChecks,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
} from "./lib/common.mjs";
import { API_PRESETS, hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";
import { RpcQaClient } from "./lib/rpc-qa-client.mjs";

const FINAL_MARKER = "SENPI_TIMEOUT_RECOVERED";
const RETRY_TIMEOUT_MS = 1_000;

function startServer() {
	const requests = [];
	const hungResponses = new Set();
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			let model = "unknown";
			try {
				model = JSON.parse(body).model ?? "unknown";
			} catch {
				model = "malformed-json";
			}
			requests.push({ attempt: requests.length + 1, url: request.url, model });
			if (requests.length === 1) {
				response.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				response.end(
					`event: error\ndata: ${JSON.stringify({ error: { message: "Request timed out.", type: "timeout_error" } })}\n\n`,
				);
				return;
			}
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			if (requests.length === 2) {
				hungResponses.add(response);
				response.once("close", () => hungResponses.delete(response));
				return;
			}
			const base = {
				id: "chatcmpl-timeout-recovery",
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
			response.end("data: [DONE]\n\n");
		});
	});
	return new Promise((resolveServer, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Failed to resolve fake server port"));
				return;
			}
			resolveServer({
				url: `http://127.0.0.1:${address.port}/v1`,
				port: address.port,
				requests,
				stop: () =>
					new Promise((done) => {
						for (const response of hungResponses) response.destroy();
						hungResponses.clear();
						server.close(done);
					}),
			});
		});
	});
}

function portIsClosed(port) {
	return new Promise((resolveClosed) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		const timer = setTimeout(() => {
			socket.destroy();
			resolveClosed(false);
		}, 500);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			resolveClosed(false);
		});
		socket.once("error", () => {
			clearTimeout(timer);
			resolveClosed(true);
		});
	});
}

async function main() {
	installCleanupHooks();
	const checks = createChecks("mock-loop-transport-timeout-recovery.mjs");
	const guard = guardRealAuth();
	const box = makeSandbox("mock-loop-transport-timeout-recovery");
	const server = await startServer();
	const evidenceFlag = process.argv[process.argv.indexOf("--evidence-dir") + 1];
	const evidencePath = evidenceFlag
		? isAbsolute(evidenceFlag)
			? evidenceFlag
			: resolve(repoRoot(), evidenceFlag)
		: join(repoRoot(), "local-ignore", "qa-evidence", "20260804-provider-timeout-retry-liveness");
	mkdirSync(evidencePath, { recursive: true });
	let client;
	let summary = { pass: false };
	try {
		const preset = API_PRESETS["openai-completions"];
		writeMockModelsJson(box.agentDir, server, "openai-completions");
		writeFileSync(
			join(box.agentDir, "settings.json"),
			JSON.stringify({
				httpIdleTimeoutMs: 0,
				retry: {
					enabled: true,
					maxRetries: 1,
					baseDelayMs: 1,
					provider: {
						maxRetries: 0,
						maxRetryDelayMs: 60_000,
						streamRetryTimeoutMs: RETRY_TIMEOUT_MS,
						streamStartTimeoutMs: 0,
					},
				},
			}),
		);
		client = new RpcQaClient({
			env: hermeticEnv(box.env),
			cwd: box.cwd,
			extraArgs: ["--provider", preset.provider, "--model", preset.modelId, "--no-extensions"],
		});
		await client.send({ type: "get_state" });
		const firstEventIndex = client.events.length;
		const firstAck = await client.send({ type: "prompt", message: "trigger timeout recovery" });
		const firstSettled = await client.waitForEvent((event) => event.type === "agent_settled", firstEventIndex);
		const idleState = await client.send({ type: "get_state" });
		const secondEventIndex = client.events.length;
		const secondAck = await client.send({ type: "prompt", message: `return ${FINAL_MARKER}` });
		await client.waitForEvent((event) => event.type === "agent_settled", secondEventIndex);
		const last = await client.send({ type: "get_last_assistant_text" });
		const markerCount = (last.data?.text ?? "").split(FINAL_MARKER).length - 1;
		const timeoutSeen = client.events.some(
			(event) => event.type === "message_end" && event.message?.errorMessage === "Request timed out.",
		);
		const pass =
			firstAck.success === true &&
			secondAck.success === true &&
			firstSettled.type === "agent_settled" &&
			idleState.data?.isStreaming === false &&
			server.requests.length === 3 &&
			markerCount === 1 &&
			timeoutSeen;
		checks.ok(
			"same RPC process settles a hung timeout retry and accepts the next prompt",
			pass,
			`requests=${server.requests.length} marker=${markerCount} streaming=${idleState.data?.isStreaming}`,
		);
		summary = { pass, markerCount, timeoutSeen, requests: server.requests, events: client.events };
	} catch (error) {
		summary = {
			...summary,
			error: error instanceof Error ? error.message : String(error),
			requests: server.requests,
			events: client?.events ?? [],
		};
		throw error;
	} finally {
		client?.close();
		let exitCode = null;
		if (client) {
			try {
				exitCode = await client.waitForExit();
			} catch {
				client.kill();
				exitCode = await client.waitForExit();
			}
		}
		await server.stop();
		const closed = await portIsClosed(server.port);
		box.cleanup();
		const sandboxRemoved = !existsSync(box.dir);
		const authUnchanged = guard.assertUnchanged();
		summary = { ...summary, cleanup: { exitCode, portClosed: closed, sandboxRemoved, authUnchanged } };
		const { events = [], ...summaryWithoutEvents } = summary;
		writeFileSync(join(evidencePath, "rpc-events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));
		writeFileSync(join(evidencePath, "request-ledger.json"), `${JSON.stringify(summary.requests ?? [], null, 2)}\n`);
		writeFileSync(join(evidencePath, "rpc-stderr.txt"), client?.stderr ?? "");
		writeFileSync(join(evidencePath, "rpc-summary.json"), `${JSON.stringify(summaryWithoutEvents, null, 2)}\n`);
		checks.ok(
			"RPC process, fake server port, sandbox, and auth state are clean",
			exitCode === 0 && closed && sandboxRemoved && authUnchanged,
			`exit=${exitCode} portClosed=${closed} sandboxRemoved=${sandboxRemoved}`,
		);
	}
	process.exitCode = checks.finish() ? 0 : 1;
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
