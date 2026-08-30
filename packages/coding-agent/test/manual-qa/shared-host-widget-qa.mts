/**
 * Shared-host extension UI wire QA.
 *
 * Run with: SENPI_CODING_AGENT_DIR=$(mktemp -d) npx tsx test/manual-qa/shared-host-widget-qa.mts
 * The driver creates and removes its own sandbox; the environment variable is
 * accepted only as a compatibility marker and is never used as the sandbox.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeModelServer } from "../helpers/rpc-fake-model.ts";
import { hermeticProviderEnv, MOCK_API_KEY, MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";

type WireRecord = Record<string, unknown>;
const timeoutMs = 15_000;
const root = mkdtempSync(join(tmpdir(), "senpi-shared-host-widget-qa-"));
const agentDir = join(root, "agent");
const cwd = join(root, "cwd");
const socketPath = join(root, "rpc.sock");
const transcriptPath = process.env.QA_TRANSCRIPT ?? join(process.cwd(), "shared-host-widget-qa-transcript.jsonl");
let host: ChildProcessWithoutNullStreams | undefined;
let socket: Socket | undefined;
let fake: Awaited<ReturnType<typeof startFakeModelServer>> | undefined;
let peerForTranscript: JsonlPeer | undefined;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

class JsonlPeer {
	readonly records: WireRecord[] = [];
	private buffer = "";
	private readonly waiters = new Set<{ predicate: (record: WireRecord) => boolean; resolve: (record: WireRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	constructor(private readonly peerSocket: Socket) {
		peerSocket.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString("utf8");
			for (;;) {
				const newline = this.buffer.indexOf("\n");
				if (newline < 0) return;
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				if (!line.trim()) continue;
				const record = JSON.parse(line) as WireRecord;
				this.records.push(record);
				for (const waiter of [...this.waiters]) {
					if (!waiter.predicate(record)) continue;
					clearTimeout(waiter.timer);
					this.waiters.delete(waiter);
					waiter.resolve(record);
				}
			}
		});
	}
	waitFor(predicate: (record: WireRecord) => boolean, label: string): Promise<WireRecord> {
		const existing = this.records.find(predicate);
		if (existing) return Promise.resolve(existing);
		const promise = new Promise<WireRecord>((resolve, reject) => {
			const waiter = { predicate, resolve, reject, timer: setTimeout(() => { this.waiters.delete(waiter); reject(new Error(`Timed out waiting for ${label}`)); }, timeoutMs) };
			this.waiters.add(waiter);
		});
		promise.catch(() => {});
		return promise;
	}
	request(command: WireRecord, label: string): Promise<WireRecord> {
		const id = command.id;
		const response = this.waitFor((record) => record.type === "response" && record.id === id, label);
		this.peerSocket.write(`${JSON.stringify(command)}\n`);
		return response;
	}
	close(): void {
		for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(new Error("socket closed")); }
		this.waiters.clear();
		this.peerSocket.destroy();
	}
}

async function connect(): Promise<JsonlPeer> {
	socket = createConnection(socketPath);
	await new Promise<void>((resolve, reject) => { socket!.once("connect", resolve); socket!.once("error", reject); });
	return new JsonlPeer(socket);
}

async function main(): Promise<void> {
	if (join(homedir(), ".senpi") === (process.env.SENPI_CODING_AGENT_DIR ?? "")) throw new Error("REFUSING: SENPI_CODING_AGENT_DIR is the real ~/.senpi");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	fake = await startFakeModelServer();
	writeRpcModelsJson(agentDir, fake.origin);
	const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");
	host = spawn(process.execPath, [cli, "--mode", "rpc", "--multi-session", "--listen", `unix://${socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL], {
		cwd,
		env: { ...process.env, ...hermeticProviderEnv(), ANTHROPIC_API_KEY: MOCK_API_KEY, PI_OFFLINE: "1", PI_TELEMETRY: "0", SENPI_RUNTIME: "node", SENPI_CODING_AGENT_DIR: agentDir, SENPI_RPC_CLIENT_CAPABILITIES: "extension_events,custom_unsupported" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const ready = new Promise<void>((resolve, reject) => {
		let stderr = "";
		const timer = setTimeout(() => { cleanup(); reject(new Error(`host readiness timeout: ${stderr}`)); }, timeoutMs);
		const onData = (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.includes(`senpi rpc listening on unix://${socketPath}`)) { cleanup(); resolve(); } };
		const onExit = () => { cleanup(); reject(new Error(`host exited before readiness: ${stderr}`)); };
		const cleanup = () => { clearTimeout(timer); host!.stderr.off("data", onData); host!.off("exit", onExit); };
		host.stderr.on("data", onData); host.once("exit", onExit);
	});
	await ready;
	const peer = await connect();
	peerForTranscript = peer;
	try {
		await peer.request({ id: "protocol", type: "get_protocol_info" }, "get_protocol_info");
		const opened = await peer.request({ id: "open", type: "open_session", cwd }, "open_session");
		const sessionId = (opened.data as WireRecord | undefined)?.sessionId;
		assert(typeof sessionId === "string", "open_session did not return sessionId");
		const widgetWait = peer.waitFor((record) => record.type === "extension_ui_request" && record.method === "setWidget" && record.widgetKey === "todo-sidebar" && Array.isArray(record.widgetLines) && (record.widgetLines as unknown[]).length > 0, "initial todo-sidebar widget");
		const promptResponse = peer.request({ id: "prompt-1", type: "prompt", sessionId, message: "/todo append QA widget item" }, "prompt");
		await promptResponse;
		const first = await widgetWait;
		const firstLines = (first.widgetLines as string[]).join("\n");
		assert(firstLines.includes("QA widget item"), "todo-sidebar widget does not contain QA widget item");
		console.log("WIDGET-LINES-OK: todo-sidebar contains QA widget item");
		assert(!peer.records.some((record) => record.type === "extension_ui_request" && record.method === "custom_unsupported"), "custom_unsupported request was emitted");
		console.log("ZERO-CUSTOM-UNSUPPORTED-OK: no custom_unsupported request");
		const priorCount = peer.records.length;
		const rerenderWait = peer.waitFor((record) => peer.records.indexOf(record) >= priorCount && record.type === "extension_ui_request" && record.method === "setWidget" && record.widgetKey === "todo-sidebar" && Array.isArray(record.widgetLines), "width rerender");
		await peer.request({ id: "width-1", type: "set_client_info", sessionId, width: 60 }, "set_client_info");
		const second = await rerenderWait;
		assert(JSON.stringify(second.widgetLines) !== JSON.stringify(first.widgetLines), "width rerender lines did not differ");
		console.log("WIDTH-RERENDER-OK: width 60 emitted different todo-sidebar lines");
		console.log("QA-PASS");
	} finally {
		peer.close();
	}
}

try {
	await main();
} catch (error) {
	console.error(`QA-FAIL ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	const { appendFileSync, mkdirSync } = await import("node:fs");
	mkdirSync(dirname(transcriptPath), { recursive: true });
	if (peerForTranscript) {
		appendFileSync(transcriptPath, peerForTranscript.records.map((record) => `${JSON.stringify(record)}\n`).join(""));
	}
	if (host && host.exitCode === null) {
		host.kill("SIGTERM");
		await Promise.race([
			new Promise<void>((resolve) => host!.once("exit", () => resolve())),
			new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
		]);
		if (host.exitCode === null) host.kill("SIGKILL");
	}
	if (fake) await fake.close().catch(() => {});
	rmSync(root, { recursive: true, force: true });
}
