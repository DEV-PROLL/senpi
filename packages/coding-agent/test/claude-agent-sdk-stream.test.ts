import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { buildPromptBlocks, buildPromptStream } from "../src/core/extensions/builtin/claude-agent-sdk/prompt-bridge.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
	type SdkQueryHandle,
} from "../src/core/extensions/builtin/claude-agent-sdk/sdk-boundary.ts";
import { streamClaudeAgentSdk } from "../src/core/extensions/builtin/claude-agent-sdk/stream.ts";

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-agent-sdk",
	provider: "claude-agent-sdk",
	baseUrl: "claude-agent-sdk",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function sdkMessage(value: unknown): SDKMessage {
	return value as SDKMessage;
}

function scriptedQuery(
	messages: readonly SDKMessage[],
	callbacks: { interrupted?: () => void; closed?: () => void } = {},
): SdkQuery {
	return () => {
		const query: SdkQueryHandle = {
			async *[Symbol.asyncIterator]() {
				for (const message of messages) yield message;
			},
			async interrupt() {
				callbacks.interrupted?.();
			},
			close() {
				callbacks.closed?.();
			},
		};
		return query;
	};
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const events: T[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

const scriptedMessages = [
	sdkMessage({
		type: "stream_event",
		event: {
			type: "message_start",
			message: {
				usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
			},
		},
	}),
	sdkMessage({
		type: "stream_event",
		event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
	}),
	sdkMessage({
		type: "stream_event",
		event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
	}),
	sdkMessage({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
	sdkMessage({
		type: "stream_event",
		event: { type: "content_block_start", index: 1, content_block: { type: "thinking" } },
	}),
	sdkMessage({
		type: "stream_event",
		event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Plan" } },
	}),
	sdkMessage({
		type: "stream_event",
		event: { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "sig" } },
	}),
	sdkMessage({ type: "stream_event", event: { type: "content_block_stop", index: 1 } }),
	sdkMessage({
		type: "stream_event",
		event: {
			type: "content_block_start",
			index: 2,
			content_block: { type: "tool_use", id: "call-1", name: "Read", input: {} },
		},
	}),
	sdkMessage({
		type: "stream_event",
		event: {
			type: "content_block_delta",
			index: 2,
			delta: { type: "input_json_delta", partial_json: '{"file_path":"src/' },
		},
	}),
	sdkMessage({
		type: "stream_event",
		event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: 'main.ts"}' } },
	}),
	sdkMessage({ type: "stream_event", event: { type: "content_block_stop", index: 2 } }),
	sdkMessage({
		type: "stream_event",
		event: {
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
		},
	}),
	sdkMessage({ type: "stream_event", event: { type: "message_stop" } }),
];

afterEach(() => resetSdkBoundary());

describe("Claude Agent SDK stream bridge", () => {
	it("bridges mixed history to one exact SDK user message", async () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Find it" },
						{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
					],
					timestamp: 1,
				},
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "repoSearch", arguments: { query: "needle" } }],
					api: "claude-agent-sdk",
					provider: "claude-agent-sdk",
					model: "claude-test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "repoSearch",
					content: [{ type: "text", text: "match" }],
					isError: false,
					timestamp: 3,
				},
			],
		};
		const blocks = buildPromptBlocks(
			context,
			new Map([["repoSearch", "mcp__custom-tools__repoSearch"]]),
			"recovered",
		);
		expect(await collect(buildPromptStream(blocks))).toEqual([
			{
				type: "user",
				parent_tool_use_id: null,
				session_id: "prompt",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "USER:\n" },
						{ type: "text", text: "Find it" },
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
						{ type: "text", text: "\n\nASSISTANT:\n" },
						{
							type: "text",
							text: 'Historical tool call (non-executable): mcp__custom-tools__repoSearch args={"query":"needle"}',
						},
						{ type: "text", text: "\n\nTOOL RESULT (historical mcp__custom-tools__repoSearch, id=call-1):\n" },
						{ type: "text", text: "match" },
						{ type: "text", text: "\n\nRECOVERED TOOL RESULTS:\n" },
						{ type: "text", text: "recovered" },
					],
				},
			},
		]);
	});

	it("maps stream events, partial tool JSON, usage, cost, and tool-use stopping", async () => {
		overrideSdkBoundary({ query: scriptedQuery(scriptedMessages) });
		const stream = streamClaudeAgentSdk(model, { messages: [] });
		const events = await collect(stream);
		const result = await stream.result();
		expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual(["Hello"]);
		expect(events.filter((event) => event.type === "thinking_delta").map((event) => event.delta)).toEqual(["Plan"]);
		expect(events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall)).toEqual([
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "src/main.ts", offset: undefined, limit: undefined },
			},
		]);
		expect(result.stopReason).toBe("toolUse");
		expect(result.usage).toMatchObject({ input: 11, output: 7, cacheRead: 5, cacheWrite: 2, totalTokens: 25 });
		expect(result.usage.cost.total).toBeCloseTo(0.0001455);
	});

	it("uses successful results as a fallback when no stream events arrive", async () => {
		overrideSdkBoundary({
			query: scriptedQuery([sdkMessage({ type: "result", subtype: "success", result: "fallback" })]),
		});
		const stream = streamClaudeAgentSdk(model, { messages: [] });
		const result = await stream.result();
		expect(result.content).toEqual([{ type: "text", text: "fallback" }]);
	});

	it("interrupts and closes the SDK query before reporting an aborted stream", async () => {
		let release: (() => void) | undefined;
		const interrupted = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started: (() => void) | undefined;
		const queryStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let interruptCount = 0;
		let closeCount = 0;
		overrideSdkBoundary({
			query: () => ({
				[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
					started?.();
					return {
						async next(): Promise<IteratorResult<SDKMessage>> {
							await interrupted;
							return { done: true, value: undefined };
						},
					};
				},
				async interrupt() {
					interruptCount++;
					release?.();
				},
				close() {
					closeCount++;
				},
			}),
		});
		const controller = new AbortController();
		const stream = streamClaudeAgentSdk(model, { messages: [] }, { signal: controller.signal });
		await queryStarted;
		controller.abort();
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Operation aborted");
		expect(interruptCount).toBe(1);
		expect(closeCount).toBeGreaterThan(0);
	});

	it("reports a query exception as an error event", async () => {
		const throwingQuery: SdkQuery = () => ({
			async *[Symbol.asyncIterator]() {
				yield scriptedMessages[0];
				throw new Error("SDK disconnected");
			},
			async interrupt() {},
			close() {},
		});
		overrideSdkBoundary({ query: throwingQuery });
		const stream = streamClaudeAgentSdk(model, { messages: [] });
		const events = await collect(stream);
		const failure = events.at(-1);
		expect(failure).toMatchObject({
			type: "error",
			reason: "error",
			error: { stopReason: "error", errorMessage: "SDK disconnected" },
		});
	});
});
