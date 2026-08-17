import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { AgentClientMessageSchema, AgentServerMessageSchema } from "../src/api/cursor-agent/gen/agent_pb.ts";
import type { CursorAgentOptions, CursorExecHandlers } from "../src/api/cursor-agent/types.ts";
import { frameConnectMessage, stream as streamCursorAgent } from "../src/api/cursor-agent.ts";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "../src/types.ts";

type ExecMode = "success" | "rejection" | "pending" | "unknown" | "shellStream";
type ClientFrame = ReturnType<typeof fromBinary<typeof AgentClientMessageSchema>>;
const EXEC_IDS: Record<ExecMode, number> = {
	success: 7,
	rejection: 8,
	pending: 9,
	unknown: 10,
	shellStream: 11,
};

class ClientFrameReader {
	#buffer = Buffer.alloc(0);
	readonly messages: ClientFrame[] = [];
	#waiters: Array<() => void> = [];

	feed(chunk: Buffer): void {
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
		while (this.#buffer.length >= 5) {
			const length = this.#buffer.readUInt32BE(1);
			if (this.#buffer.length < 5 + length) break;
			const bytes = this.#buffer.subarray(5, 5 + length);
			this.#buffer = this.#buffer.subarray(5 + length);
			this.messages.push(fromBinary(AgentClientMessageSchema, bytes));
			for (const waiter of this.#waiters.splice(0)) waiter();
		}
	}

	async waitFor<T>(select: () => T | undefined, timeoutMs = 5000): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const found = select();
			if (found !== undefined) return found;
			if (Date.now() > deadline) throw new Error("Timed out waiting for client frame");
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 25);
				this.#waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}
}

function buildModel(baseUrl: string): Model<"cursor-agent"> {
	return {
		id: "claude-4.6-opus-high",
		name: "Opus 4.6",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

function serverFrame(init: Parameters<typeof create<typeof AgentServerMessageSchema>>[1]): Buffer {
	return frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, init)));
}

function turnEndedFrame(): Buffer {
	return serverFrame({
		message: { case: "interactionUpdate", value: { message: { case: "turnEnded", value: {} } } },
	});
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

async function observeServerTask(task: Promise<void>): Promise<unknown> {
	try {
		await task;
		return undefined;
	} catch (error) {
		return error;
	}
}

async function runScenario(mode: ExecMode): Promise<{
	readonly frames: ClientFrameReader["messages"];
	readonly message: AssistantMessage;
}> {
	const id = EXEC_IDS[mode];
	const pendingRead = Promise.withResolvers<ToolResultMessage>();
	const reader = new ClientFrameReader();
	const server = http2.createServer();
	let serverTask: Promise<unknown> | undefined;
	server.on("stream", (stream) => {
		stream.on("data", (chunk: Buffer) => reader.feed(chunk));
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		serverTask = observeServerTask(
			(async () => {
				try {
					await reader.waitFor(() => reader.messages.find((item) => item.message.case === "runRequest"));
					stream.write(
						serverFrame({
							message: {
								case: "execServerMessage",
								value:
									mode === "unknown"
										? { id, execId: `exec-${id}` }
										: mode === "shellStream"
											? {
													id,
													execId: `exec-${id}`,
													message: {
														case: "shellStreamArgs",
														value: { command: "printf shell", toolCallId: "call-shell-stream" },
													},
												}
											: {
													id,
													execId: `exec-${id}`,
													message: {
														case: "readArgs",
														value: { path: `${mode}.ts`, toolCallId: `call-${mode}` },
													},
												},
							},
						}),
					);
					if (mode === "unknown") {
						await reader.waitFor(() => findControlFrames(reader.messages, "throw", id)[0], 500);
						await reader.waitFor(() => findControlFrames(reader.messages, "streamClose", id)[0], 500);
						stream.write(turnEndedFrame());
						return;
					}
					if (mode === "pending") {
						expect(findControlFrames(reader.messages, "heartbeat", id)).toHaveLength(0);
						await reader.waitFor(() => findControlFrames(reader.messages, "heartbeat", id)[0], 4500);
						pendingRead.resolve(toolResult("call-pending", "slow file contents"));
					}
					const reply = await reader.waitFor(() =>
						reader.messages.find(
							(item) =>
								item.message.case === "execClientMessage" &&
								item.message.value.message.case === (mode === "shellStream" ? "shellResult" : "readResult"),
						),
					);
					if (reply.message.case !== "execClientMessage") {
						throw new Error("Expected exec result");
					}
					if (reply.message.value.message.case === "readResult") {
						expect(reply.message.value.message.value.result.case).toBe(
							mode === "rejection" ? "rejected" : "success",
						);
					}
					await reader.waitFor(() => findControlFrames(reader.messages, "streamClose", id)[0], 500);
					expect(findControlFrames(reader.messages, "streamClose", id)).toHaveLength(1);
					stream.write(turnEndedFrame());
				} finally {
					pendingRead.resolve(toolResult("call-pending", "cleanup"));
					stream.end();
				}
			})(),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP server address");
	const execHandlers: CursorExecHandlers | undefined =
		mode === "rejection" || mode === "unknown" || mode === "shellStream"
			? undefined
			: {
					read: async (args) =>
						mode === "pending" ? await pendingRead.promise : toolResult(args.toolCallId, "file contents"),
				};
	const stream = streamCursorAgent(
		buildModel(`http://127.0.0.1:${address.port}`),
		{ messages: [{ role: "user", content: "hello", timestamp: 0 }] satisfies Message[] },
		{ apiKey: "test-token", execHandlers } satisfies CursorAgentOptions,
	);
	for await (const _event of stream) {
		// Drain the public stream while the fake server enforces the wire contract.
	}
	const message = await stream.result();
	if (!serverTask) throw new Error("Expected server task");
	const serverError = await serverTask;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (serverError) throw serverError;
	return { frames: reader.messages, message };
}

function findControlFrames(
	messages: readonly ClientFrame[],
	controlCase: "heartbeat" | "streamClose" | "throw",
	id: number,
) {
	return messages.filter(
		(item) =>
			item.message.case === "execClientControlMessage" &&
			item.message.value.message.case === controlCase &&
			item.message.value.message.value.id === id,
	);
}

describe("cursor-agent exec lifecycle", () => {
	it("closes the exec stream after a successful readResult", async () => {
		const { frames, message } = await runScenario("success");
		expect(findControlFrames(frames, "streamClose", 7)).toHaveLength(1);
		expect(message.stopReason).toBe("stop");
	});

	it("closes the exec stream after a typed read rejection", async () => {
		const { frames, message } = await runScenario("rejection");
		expect(findControlFrames(frames, "streamClose", 8)).toHaveLength(1);
		expect(message.stopReason).toBe("stop");
	});

	it("heartbeats a pending exec and stops after completion", async () => {
		const { frames, message } = await runScenario("pending");
		expect(findControlFrames(frames, "heartbeat", 9)).toHaveLength(1);
		expect(findControlFrames(frames, "streamClose", 9)).toHaveLength(1);
		expect(message.stopReason).toBe("stop");
	});

	it("preserves unknown-frame throw then streamClose fallback", async () => {
		const { frames, message } = await runScenario("unknown");
		expect(findControlFrames(frames, "throw", 10)).toHaveLength(1);
		expect(findControlFrames(frames, "streamClose", 10)).toHaveLength(1);
		expect(message.stopReason).toBe("stop");
	});

	it("closes a shell stream exactly once", async () => {
		const { frames, message } = await runScenario("shellStream");
		expect(findControlFrames(frames, "streamClose", 11)).toHaveLength(1);
		expect(message.stopReason).toBe("stop");
	});
});
