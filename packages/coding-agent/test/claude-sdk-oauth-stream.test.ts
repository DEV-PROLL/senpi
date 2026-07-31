import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SDKUserMessage,
	type SdkQuery,
	type SdkQueryHandle,
} from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	closeSession,
	getSession,
	markTainted,
	overrideSessionRegistryBoundary,
	recordBranchInfo,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
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

const sessionIds = new Set<string>();

class ResidentQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	readonly submitted: SDKUserMessage[] = [];
	readonly options: Options;
	closes = 0;
	private readonly initializationError: Error | undefined;
	private readonly queued: SDKMessage[] = [];
	private readonly readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];

	constructor(prompt: AsyncIterable<SDKUserMessage>, options: Options, initializationError?: Error) {
		this.options = options;
		this.initializationError = initializationError;
		void this.consume(prompt);
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
		return this;
	}

	next(): Promise<IteratorResult<SDKMessage>> {
		const value = this.queued.shift();
		if (value) return Promise.resolve({ value, done: false });
		return new Promise((resolve) => this.readers.push(resolve));
	}

	async initializationResult(): Promise<Record<string, never>> {
		if (this.initializationError) throw this.initializationError;
		return {};
	}

	async interrupt(): Promise<void> {}

	close(): void {
		this.closes++;
		for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
	}

	private emit(message: SDKMessage): void {
		const reader = this.readers.shift();
		if (reader) reader({ value: message, done: false });
		else this.queued.push(message);
	}

	private async consume(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
		for await (const message of prompt) {
			this.submitted.push(message);
			const uuid = message.uuid ?? `submitted-${this.submitted.length}`;
			const sessionId = message.session_id;
			this.emit(sdkMessage({ ...message, uuid, session_id: sessionId, isReplay: true }));
			this.emit(
				sdkMessage({
					type: "assistant",
					message: { id: `message-${uuid}`, type: "message", role: "assistant", content: [] },
					parent_tool_use_id: null,
					uuid: `assistant-${uuid}`,
					session_id: sessionId,
				}),
			);
			this.emit(
				sdkMessage({
					type: "result",
					subtype: "success",
					result: `answer-${this.submitted.length}`,
					user_message_uuid: uuid,
					uuid: `result-${uuid}`,
					session_id: sessionId,
				}),
			);
		}
	}
}

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "claude-sdk-oauth",
		provider: "claude-sdk-oauth",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function mainOptions(sessionId: string) {
	sessionIds.add(sessionId);
	return { sessionId, streamKind: "main" as const };
}

function textFrom(message: SDKUserMessage): string {
	const content = message.message.content;
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("");
}

function residentBoundary(initializationFailures = new Set<number>()) {
	const queries: ResidentQuery[] = [];
	const query: SdkQuery = (input) => {
		const { prompt, options = {} } = input;
		if (options.extraArgs?.["replay-user-messages"] !== "") {
			return scriptedQuery([sdkMessage({ type: "result", subtype: "success", result: "ephemeral" })])(input);
		}
		if (typeof prompt === "string") throw new Error("Expected streaming input");
		const resident = new ResidentQuery(
			prompt,
			options,
			initializationFailures.has(queries.length) ? new Error("resume initialization failed") : undefined,
		);
		queries.push(resident);
		return resident;
	};
	overrideSdkBoundary({ query });
	overrideSessionRegistryBoundary({ queryFactory: query });
	return queries;
}

afterEach(() => {
	for (const sessionId of sessionIds) closeSession(sessionId, "test_cleanup");
	sessionIds.clear();
	resetSessionRegistryBoundary();
	resetSdkBoundary();
});

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

	it("reuses one resident query and sends only the new sent-stream suffix", async () => {
		const queries = residentBoundary();
		const sessionId = "resident-reuse";
		const first: Context = { messages: [{ role: "user", content: "first", timestamp: 1 }] };
		await streamClaudeSdkOauth(model, first, mainOptions(sessionId)).result();
		const second: Context = {
			messages: [
				first.messages[0]!,
				assistant("first answer", 2),
				{ role: "user", content: "second", timestamp: 3 },
			],
		};
		await streamClaudeSdkOauth(model, second, mainOptions(sessionId)).result();

		expect(queries).toHaveLength(1);
		expect(queries[0]?.submitted).toHaveLength(2);
		expect(textFrom(queries[0]!.submitted[0]!)).toContain("first");
		expect(textFrom(queries[0]!.submitted[1]!)).toBe("second");
		expect(textFrom(queries[0]!.submitted[1]!)).not.toContain("first");
		expect(queries[0]?.closes).toBe(0);
	});

	it("resumes and forks at an assistant boundary when tree navigation is a strict sent-stream prefix", async () => {
		const queries = residentBoundary();
		const sessionId = "resident-prefix-branch";
		const user1 = { role: "user" as const, content: "one", timestamp: 1 };
		const user2 = { role: "user" as const, content: "two", timestamp: 3 };
		const user3 = { role: "user" as const, content: "three", timestamp: 5 };
		await streamClaudeSdkOauth(model, { messages: [user1] }, mainOptions(sessionId)).result();
		await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), user2] },
			mainOptions(sessionId),
		).result();
		await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), user2, assistant("a2", 4), user3] },
			mainOptions(sessionId),
		).result();
		recordBranchInfo(sessionId, { oldLeafId: "old", newLeafId: "new" });

		await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), user2] },
			mainOptions(sessionId),
		).result();

		expect(queries).toHaveLength(2);
		expect(queries[0]?.closes).toBe(1);
		expect(queries[1]?.options).toMatchObject({
			resume: expect.any(String),
			resumeSessionAt: expect.stringContaining("assistant-"),
			forkSession: true,
		});
		expect(textFrom(queries[1]!.submitted[0]!)).toBe("two");
	});

	it("cold-seeds after tree navigation when the sent stream is not a prefix", async () => {
		const queries = residentBoundary();
		const sessionId = "resident-diverged-branch";
		const user1 = { role: "user" as const, content: "one", timestamp: 1 };
		const user2 = { role: "user" as const, content: "two", timestamp: 3 };
		await streamClaudeSdkOauth(model, { messages: [user1] }, mainOptions(sessionId)).result();
		await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), user2] },
			mainOptions(sessionId),
		).result();
		recordBranchInfo(sessionId, { oldLeafId: "old", newLeafId: "new" });

		await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), { role: "user", content: "other", timestamp: 4 }] },
			mainOptions(sessionId),
		).result();

		expect(queries).toHaveLength(2);
		expect(queries[1]?.options.resume).toBeUndefined();
		expect(textFrom(queries[1]!.submitted[0]!)).toContain("one");
		expect(textFrom(queries[1]!.submitted[0]!)).toContain("other");
	});

	it("cold-seeds the next turn after compaction taints a resident query", async () => {
		const queries = residentBoundary();
		const sessionId = "resident-compaction";
		const user1 = { role: "user" as const, content: "one", timestamp: 1 };
		await streamClaudeSdkOauth(model, { messages: [user1] }, mainOptions(sessionId)).result();
		markTainted(sessionId, "compaction");
		await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), { role: "user", content: "two", timestamp: 3 }] },
			mainOptions(sessionId),
		).result();

		expect(queries).toHaveLength(2);
		expect(queries[0]?.closes).toBe(1);
		expect(queries[1]?.options.resume).toBeUndefined();
		expect(textFrom(queries[1]!.submitted[0]!)).toContain("one");
	});

	it("falls back loudly to a cold seed when resumed-query initialization rejects", async () => {
		const queries = residentBoundary(new Set([1]));
		const sessionId = "resident-resume-failure";
		const user1 = { role: "user" as const, content: "one", timestamp: 1 };
		const user2 = { role: "user" as const, content: "two", timestamp: 3 };
		const user3 = { role: "user" as const, content: "three", timestamp: 5 };
		await streamClaudeSdkOauth(model, { messages: [user1] }, mainOptions(sessionId)).result();
		await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), user2] },
			mainOptions(sessionId),
		).result();
		await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), user2, assistant("a2", 4), user3] },
			mainOptions(sessionId),
		).result();
		recordBranchInfo(sessionId, { oldLeafId: "old", newLeafId: "new" });

		const result = await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), user2] },
			mainOptions(sessionId),
		).result();

		expect(queries).toHaveLength(3);
		expect(queries[1]?.options.resumeSessionAt).toEqual(expect.any(String));
		expect(queries[1]?.closes).toBe(1);
		expect(queries[2]?.options.resume).toBeUndefined();
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				type: "claude_sdk_oauth_resume_fallback",
				error: expect.objectContaining({ message: "resume initialization failed" }),
			}),
		]);
	});

	it("keeps unmarked auxiliary calls out of the session registry", async () => {
		let queries = 0;
		overrideSdkBoundary({
			query: scriptedQuery([sdkMessage({ type: "result", subtype: "success", result: "auxiliary" })], {
				consumed: () => {
					queries++;
				},
			}),
		});
		const sessionId = "auxiliary-registry-gate";
		sessionIds.add(sessionId);
		await streamClaudeSdkOauth(model, { messages: [] }, { sessionId }).result();

		expect(queries).toBe(1);
		expect(getSession(sessionId)).toBeUndefined();
	});
});
