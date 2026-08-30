import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type AgentSessionRuntime,
} from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	createInteractiveHostRuntime,
	INTERACTIVE_HOST_FALLBACK_WARNING,
} from "../src/modes/interactive/interactive-host-runtime.ts";
import { attachJsonlLineReader } from "../src/modes/rpc/jsonl.ts";
import type { RpcSessionState } from "../src/modes/rpc/rpc-types.ts";

const roots: string[] = [];
const servers: Server[] = [];
const acceptedSockets: Socket[] = [];
const runtimes: AgentSessionRuntime[] = [];

const TEST_TIMEOUT = 10_000;

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose().catch(() => {})));
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					for (const socket of acceptedSockets.splice(0)) socket.destroy();
				}),
		),
	);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(label: string) {
	const root = mkdtempSync(join(tmpdir(), `senpi-interactive-reconnect-${label}-`));
	roots.push(root);
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	return { root, cwd, agentDir, sessionDir, socket: join(root, "rpc.sock") };
}

function stateFor(sessionPath: string, sessionId: string, cwd: string): RpcSessionState {
	return {
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionFile: sessionPath,
		sessionId,
		cwd,
		projectTrusted: true,
		favoriteModels: [],
		scopedModels: [],
		steering: [],
		followUp: [],
		ordered: [],
		autoCompactionEnabled: true,
		fastMode: false,
		messageCount: 0,
		pendingMessageCount: 0,
		usageTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined },
		retryAttempt: 0,
		isBashRunning: false,
	};
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => (resolve = done));
	return { promise, resolve };
}

class FakeHost {
	readonly server = createServer();
	readonly connections: Socket[] = [];
	readonly requests: Array<Record<string, unknown>> = [];
	readonly secondConnection = deferred<Socket>();
	readonly thirdConnection = deferred<Socket>();
	readonly secondOpenSession = deferred<Record<string, unknown>>();
	private readonly sessionPath: string;
	private readonly cwd: string;
	private readonly sessionId = "fake-session";
	private connectionCount = 0;

	readonly socketPath: string;

	constructor(socketPath: string, sessionPath: string, cwd: string) {
		this.socketPath = socketPath;
		this.sessionPath = sessionPath;
		this.cwd = cwd;
		this.server.on("connection", (socket) => this.accept(socket));
	}

	async listen(): Promise<void> {
		await new Promise<void>((resolve) => this.server.listen(this.socketPath, resolve));
		servers.push(this.server);
	}

	private accept(socket: Socket): void {
		this.connectionCount++;
		this.connections.push(socket);
		acceptedSockets.push(socket);
		if (this.connectionCount === 2) this.secondConnection.resolve(socket);
		if (this.connectionCount === 3) this.thirdConnection.resolve(socket);
		attachJsonlLineReader(socket, (line) => {
			const request = JSON.parse(line) as Record<string, unknown>;
			this.requests.push(request);
			if (request.type === "open_session" && this.requests.filter((item) => item.type === "open_session").length === 2) {
				this.secondOpenSession.resolve(request);
			}
			void this.respond(socket, request);
		});
	}

	private async respond(socket: Socket, request: Record<string, unknown>): Promise<void> {
		const id = request.id;
		let data: unknown;
		if (request.type === "open_session") {
			data = {
				sessionId: this.sessionId,
				attached: this.requests.filter((item) => item.type === "open_session").length > 1,
				state: stateFor(this.sessionPath, this.sessionId, this.cwd),
			};
		} else if (request.type === "get_state") {
			data = stateFor(this.sessionPath, this.sessionId, this.cwd);
		} else if (request.type === "close_session") {
			data = {};
		} else {
			data = {};
		}
		socket.write(`${JSON.stringify({ id, type: "response", command: request.type, success: true, data })}\n`);
	}
}

async function createLocalRuntime(qa: ReturnType<typeof scratch>): Promise<AgentSessionRuntime> {
	const sessionManager = SessionManager.create(qa.cwd, qa.sessionDir);
	const settingsManager = SettingsManager.create(qa.cwd, qa.agentDir);
	const services = await createAgentSessionServices({
		cwd: qa.cwd,
		agentDir: qa.agentDir,
		settingsManager,
		resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
	});
	const runtime = await createAgentSessionRuntime(
		async ({ sessionManager: manager }) => ({
			...(await createAgentSessionFromServices({ services, sessionManager: manager })),
			services,
			diagnostics: services.diagnostics,
		}),
		{ cwd: qa.cwd, agentDir: qa.agentDir, sessionManager },
	);
	runtimes.push(runtime);
	return runtime;
}

describe("interactive host reconnect orchestration", () => {
	it("reconnects the shared host after the accepted socket is killed without fallback", async () => {
		const qa = scratch("reconnect");
		const local = await createLocalRuntime(qa);
		const sessionPath = local.session.sessionFile!;
		const host = new FakeHost(qa.socket, sessionPath, qa.cwd);
		await host.listen();
		const warnings: Array<{ message: string; cause: unknown }> = [];
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => undefined,
			onWarning: (warning) => warnings.push(warning),
		});
		try {
			expect(host.connections).toHaveLength(1);
		host.connections[0]!.destroy();
			await host.secondConnection.promise;
			await host.secondOpenSession.promise;
			expect(host.connections).toHaveLength(2);
			expect(host.requests.filter((request) => request.type === "open_session")).toHaveLength(2);
			expect(warnings).toEqual([]);
		} finally {
			await runtime.dispose();
		}
	}, TEST_TIMEOUT);

	it("sanitizes later proxy failures and deduplicates the fallback warning", async () => {
		const qa = scratch("sanitized");
		const local = await createLocalRuntime(qa);
		const host = new FakeHost(qa.socket, local.session.sessionFile!, qa.cwd);
		await host.listen();
		const warnings: Array<{ message: string; cause: unknown }> = [];
		let ensureHostCalls = 0;
		const warning = deferred<void>();
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => {
				ensureHostCalls++;
				if (ensureHostCalls > 1) throw new Error("internal socket path / secret");
				return undefined;
			},
			onWarning: (value) => {
				warnings.push(value);
				warning.resolve();
			},
		});
		try {
			host.connections[0]!.destroy();
			const action = runtime.session.steer("after disconnect");
			await expect(action).rejects.toThrow();
			await warning.promise;
			await Promise.resolve();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.message).toBe(INTERACTIVE_HOST_FALLBACK_WARNING);
			expect(warnings[0]?.message).not.toContain("internal socket path");
		} finally {
			await runtime.dispose();
		}
	}, TEST_TIMEOUT);

	it("switches to the local runtime after reconnect exhaustion", async () => {
		const qa = scratch("fallback");
		const local = await createLocalRuntime(qa);
		const host = new FakeHost(qa.socket, local.session.sessionFile!, qa.cwd);
		await host.listen();
		const warning = deferred<void>();
		let ensureHostCalls = 0;
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => {
				ensureHostCalls++;
				if (ensureHostCalls > 1) throw new Error("reconnect failed");
				return undefined;
			},
			onWarning: () => warning.resolve(),
		});
		try {
			host.connections[0]!.destroy();
			await warning.promise;
			expect(runtime.session).toBe(local.session);
			expect(host.requests.filter((request) => request.type === "get_state")).toHaveLength(0);
		} finally {
			await runtime.dispose();
		}
	}, TEST_TIMEOUT);

	it("re-arms reconnect when the socket disconnects during a successful reconnect", async () => {
		const qa = scratch("race");
		const local = await createLocalRuntime(qa);
		const host = new FakeHost(qa.socket, local.session.sessionFile!, qa.cwd);
		await host.listen();
		const runtime = await createInteractiveHostRuntime(local, { socket: qa.socket, ensureHost: async () => undefined });
		try {
			host.connections[0]!.destroy();
			await host.secondConnection.promise;
			await host.secondOpenSession.promise;
			// The reconnect has completed; a later disconnect must start another attempt.
			host.connections[1]!.destroy();
			await host.thirdConnection.promise;
			expect(host.connections.length).toBeGreaterThanOrEqual(3);
		} finally {
			await runtime.dispose();
		}
	}, TEST_TIMEOUT);

	it("dispose cancels an in-flight reconnect before reopening the session", async () => {
		const qa = scratch("dispose");
		const local = await createLocalRuntime(qa);
		const host = new FakeHost(qa.socket, local.session.sessionFile!, qa.cwd);
		await host.listen();
		const reconnectStarted = deferred<void>();
		const releaseReconnect = deferred<void>();
		let ensureHostCalls = 0;
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => {
				ensureHostCalls++;
				if (ensureHostCalls > 1) {
					reconnectStarted.resolve();
					await releaseReconnect.promise;
				}
				return undefined;
			},
		});
		try {
			host.connections[0]!.destroy();
			await reconnectStarted.promise;
			const disposed = runtime.dispose();
			releaseReconnect.resolve();
			await disposed;
			expect(host.requests.filter((request) => request.type === "open_session")).toHaveLength(1);
		} finally {
			releaseReconnect.resolve();
			await runtime.dispose().catch(() => {});
		}
	}, TEST_TIMEOUT);

	it("emits one sanitized fallback warning after bounded reconnect failure", async () => {
		const qa = scratch("fallback");
		const local = await createLocalRuntime(qa);
		const sessionPath = local.session.sessionFile!;
		const host = new FakeHost(qa.socket, sessionPath, qa.cwd);
		await host.listen();
		const warnings: Array<{ message: string; cause: unknown }> = [];
		let ensureHostCalls = 0;
		const warning = deferred<void>();
		const runtime = await createInteractiveHostRuntime(local, {
			socket: qa.socket,
			ensureHost: async () => {
				ensureHostCalls++;
				if (ensureHostCalls > 1) throw new Error("Client not started");
				return undefined;
			},
			onWarning: (value) => {
				warnings.push(value);
				warning.resolve();
			},
		});
		try {
			host.connections[0]!.destroy();
			await warning.promise;
			expect(ensureHostCalls).toBe(4);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.message).toBe(INTERACTIVE_HOST_FALLBACK_WARNING);
			expect(warnings.every(({ message }) => !message.includes("Client not started"))).toBe(true);
		} finally {
			await runtime.dispose();
		}
	}, TEST_TIMEOUT);
});
