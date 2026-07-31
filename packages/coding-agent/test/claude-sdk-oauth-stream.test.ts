import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
	type SdkQueryHandle,
} from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { streamClaudeSdkOauth } from "../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "claude-sdk-oauth",
	baseUrl: "claude-sdk-oauth",
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
	callbacks: { interrupted?: () => void; closed?: () => void; consumed?: (message: SDKMessage) => void } = {},
): SdkQuery {
	return () => {
		const query: SdkQueryHandle = {
			async *[Symbol.asyncIterator]() {
				for (const message of messages) {
					callbacks.consumed?.(message);
					yield message;
				}
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
	sdkMessage({
		type: "result",
		subtype: "success",
		result: "",
		stop_reason: "tool_use",
		usage: { input_tokens: 13, output_tokens: 9, cache_read_input_tokens: 6, cache_creation_input_tokens: 3 },
	}),
];

afterEach(() => resetSdkBoundary());

describe("Claude SDK OAuth stream events", () => {
	it("maps stream events, drains through the terminal result, and uses its usage and stop reason", async () => {
		let consumedTerminalResult = false;
		overrideSdkBoundary({
			query: scriptedQuery(scriptedMessages, {
				consumed: (message) => {
					if (message.type === "result") consumedTerminalResult = true;
				},
			}),
		});
		const stream = streamClaudeSdkOauth(model, { messages: [] });
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
		expect(consumedTerminalResult).toBe(true);
		expect(result.stopReason).toBe("toolUse");
		expect(result.usage).toMatchObject({ input: 13, output: 9, cacheRead: 6, cacheWrite: 3, totalTokens: 31 });
		expect(result.usage.cost.total).toBeCloseTo(0.0001848);
	});

	it("uses successful results as a fallback when no stream events arrive", async () => {
		overrideSdkBoundary({
			query: scriptedQuery([
				sdkMessage({
					type: "result",
					subtype: "success",
					result: "fallback",
					stop_reason: "end_turn",
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			]),
		});
		const stream = streamClaudeSdkOauth(model, { messages: [] });
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
		const stream = streamClaudeSdkOauth(model, { messages: [] }, { signal: controller.signal });
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
		const stream = streamClaudeSdkOauth(model, { messages: [] });
		const events = await collect(stream);
		const failure = events.at(-1);
		expect(failure).toMatchObject({
			type: "error",
			reason: "error",
			error: { stopReason: "error", errorMessage: "SDK disconnected" },
		});
	});
});
