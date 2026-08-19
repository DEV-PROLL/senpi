import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { AgentServerMessageSchema } from "../src/api/cursor-agent/gen/agent_pb.ts";
import { frameConnectMessage, stream as streamCursorAgent } from "../src/api/cursor-agent.ts";
import type { Model } from "../src/types.ts";

process.env.CURSOR_CONVERSATION_ID_STORE = join(mkdtempSync(join(tmpdir(), "cursor-rotate-")), "ids.json");

const neverAbortedSignal = new AbortController().signal;
const CONNECT_END_STREAM_FLAG = 0b00000010;

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

function turnEndedFrame(): Buffer {
	return frameConnectMessage(
		toBinary(
			AgentServerMessageSchema,
			create(AgentServerMessageSchema, {
				message: { case: "interactionUpdate", value: { message: { case: "turnEnded", value: {} } } },
			}),
		),
	);
}

function endStreamErrorFrame(code: string, message: string): Buffer {
	return frameConnectMessage(
		new TextEncoder().encode(JSON.stringify({ error: { code, message } })),
		CONNECT_END_STREAM_FLAG,
	);
}

let server: http2.Http2Server | undefined;

async function startServer(handler: (stream: http2.ServerHttp2Stream) => void): Promise<string> {
	server = http2.createServer();
	server.on("stream", (stream) => {
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		handler(stream);
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

describe("cursor-agent zero-token RE retry", () => {
	afterEach(async () => {
		if (!server) return;
		await new Promise<void>((resolve) => server!.close(() => resolve()));
		server = undefined;
	});

	it("retries the same stream() with a new conversation id", async () => {
		let runs = 0;
		const baseUrl = await startServer((stream) => {
			runs += 1;
			if (runs === 1) {
				stream.write(endStreamErrorFrame("resource_exhausted", "Error"));
				stream.end();
				return;
			}
			stream.write(turnEndedFrame());
			stream.end();
		});
		const result = streamCursorAgent(
			buildModel(baseUrl),
			{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
			{ apiKey: "test-token", sessionId: "sess-rotate-stream", signal: neverAbortedSignal },
		);
		for await (const _event of result) {
			// drain
		}
		const message = await result.result();
		expect(runs).toBe(2);
		expect(message.stopReason).not.toBe("error");
	});
});
