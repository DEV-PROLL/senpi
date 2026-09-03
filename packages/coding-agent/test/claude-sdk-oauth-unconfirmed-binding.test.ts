import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { decideNativeContinuity } from "../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";
import { forgetBinding, getBinding } from "../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import {
	closeSession,
	getOrCreateSession,
	getSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { createSessionTurnAttempt } from "../src/core/extensions/builtin/claude-sdk-oauth/session-turn-attempt.ts";

class ScriptedQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	private done = false;
	private readonly queued: SDKMessage[] = [];
	private readonly readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];

	[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
		return this;
	}

	next(): Promise<IteratorResult<SDKMessage>> {
		const value = this.queued.shift();
		if (value) return Promise.resolve({ value, done: false });
		if (this.done) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve) => this.readers.push(resolve));
	}

	emit(message: SDKMessage): void {
		const reader = this.readers.shift();
		if (reader) reader({ value: message, done: false });
		else this.queued.push(message);
	}

	async interrupt(): Promise<void> {}

	close(): void {
		this.done = true;
		for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
	}
}

const SESSION_ID = "unconfirmed-binding";
const HASHES = ["turn-hash"];
const userContent = { role: "user", content: "hello" } as const;

function replay(uuid: string, sessionId: string): SDKMessage {
	return {
		type: "user",
		message: userContent,
		parent_tool_use_id: null,
		uuid,
		session_id: sessionId,
		isReplay: true,
	} as SDKMessage;
}

function result(uuid: string, sessionId: string, isError: boolean): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		user_message_uuid: uuid,
		uuid: "result",
		session_id: sessionId,
		is_error: isError,
		result: isError ? "No conversation found with session ID" : "done",
	} as unknown as SDKMessage;
}

function init(sessionId: string): SDKMessage {
	return { type: "system", subtype: "init", session_id: sessionId } as unknown as SDKMessage;
}

function fixture(resume?: string) {
	const query = new ScriptedQuery();
	overrideSessionRegistryBoundary({ queryFactory: () => query });
	const entry = getOrCreateSession({
		senpiSessionId: SESSION_ID,
		accountName: "default",
		modelId: "claude-test",
		toolsetHash: "tools-v1",
		systemPromptHash: "prompt-v1",
		options: {},
		...(resume ? { resume: { sdkSessionId: resume } } : {}),
	});
	const attempt = createSessionTurnAttempt(entry, userContent, HASHES, undefined, { emit() {} });
	return { query, entry, attempt };
}

async function submittedMessage(entry: { inputController: AsyncIterable<SDKUserMessage> }): Promise<SDKUserMessage> {
	const item = await entry.inputController[Symbol.asyncIterator]().next();
	if (item.done) throw new Error("Expected a submitted user message");
	return item.value;
}

async function consume(messages: AsyncIterable<SDKMessage>): Promise<void> {
	for await (const _message of messages) {
		// Exhaust the attempt so it publishes or forgets its retry checkpoint.
	}
}

afterEach(() => {
	closeSession(SESSION_ID, "test_cleanup");
	forgetBinding(SESSION_ID);
	resetSessionRegistryBoundary();
});

describe("claude-sdk-oauth unconfirmed continuity bindings", () => {
	it("forgets a cold-seed id when failure arrives before init confirmation", async () => {
		const { query, entry, attempt } = fixture();
		const consuming = consume(attempt.messages);
		const submitted = await submittedMessage(entry);
		query.emit(result(submitted.uuid!, entry.sdkSessionId, true));

		await expect(consuming).rejects.toThrow("No conversation found");
		expect(getSession(SESSION_ID)).toBeUndefined();
		expect(getBinding(SESSION_ID)).toBeUndefined();
		expect(
			decideNativeContinuity({
				entry: undefined,
				binding: undefined,
				currentHashes: HASHES,
				accountName: "default",
				modelId: "claude-test",
				fingerprint: { toolsetHash: "tools-v1", systemPromptHash: "prompt-v1" },
				transcriptAvailable: false,
			}),
		).toEqual({ kind: "bootstrap" });
	});

	it("retains a retry checkpoint after init confirms the SDK session id", async () => {
		const { query, entry, attempt } = fixture();
		const consuming = consume(attempt.messages);
		const submitted = await submittedMessage(entry);
		const confirmedId = "sdk-confirmed";
		query.emit(init(confirmedId));
		query.emit(replay(submitted.uuid!, confirmedId));
		query.emit(result(submitted.uuid!, confirmedId, true));

		await expect(consuming).rejects.toThrow("No conversation found");
		expect(getBinding(SESSION_ID)).toMatchObject({ sdkSessionId: confirmedId, sentCount: 0 });
	});

	it("records a successful confirmed turn exactly as before", async () => {
		const { query, entry, attempt } = fixture();
		const consuming = consume(attempt.messages);
		const submitted = await submittedMessage(entry);
		query.emit(init(entry.sdkSessionId));
		query.emit(replay(submitted.uuid!, entry.sdkSessionId));
		query.emit(result(submitted.uuid!, entry.sdkSessionId, false));

		await consuming;
		expect(getBinding(SESSION_ID)).toMatchObject({
			sdkSessionId: entry.sdkSessionId,
			sentCount: 1,
			sentHashes: HASHES,
		});
	});

	it("treats a resume-created entry as already confirmed", async () => {
		const resumedId = "sdk-resumed";
		const { query, entry, attempt } = fixture(resumedId);
		const consuming = consume(attempt.messages);
		const submitted = await submittedMessage(entry);
		query.emit(replay(submitted.uuid!, resumedId));
		query.emit(result(submitted.uuid!, resumedId, true));

		await expect(consuming).rejects.toThrow("No conversation found");
		expect(getBinding(SESSION_ID)).toMatchObject({ sdkSessionId: resumedId, sentCount: 0 });
	});
});
