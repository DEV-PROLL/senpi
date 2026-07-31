import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountSlot } from "../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	ClaudeSdkOauthSessionRegistry,
	isBoundAccountTokenExpiring,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
	SESSION_REGISTRY_IDLE_TTL_MS,
	SessionRegistryResourceLimitError,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import {
	ConcurrentSessionTurnAdmissionError,
	submitSessionTurn,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry-pump.ts";
import { transitionSessionState } from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry-state.ts";

class ScriptedQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	readonly emitted: SDKMessage[] = [];
	interrupts = 0;
	closes = 0;
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
		this.emitted.push(message);
		const reader = this.readers.shift();
		if (reader) reader({ value: message, done: false });
		else this.queued.push(message);
	}

	finish(): void {
		this.done = true;
		for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
	}

	async interrupt(): Promise<void> {
		this.interrupts++;
	}

	close(): void {
		this.closes++;
	}
}

const userContent = { role: "user", content: "hello" } as const;
const replay = (uuid: string, sessionId: string): SDKMessage =>
	({
		type: "user",
		message: userContent,
		parent_tool_use_id: null,
		uuid,
		session_id: sessionId,
		isReplay: true,
	}) as SDKMessage;
const streamEvent = (uuid: string, sessionId: string): SDKMessage =>
	({
		type: "stream_event",
		event: { type: "message_stop" },
		parent_tool_use_id: null,
		uuid,
		session_id: sessionId,
	}) as SDKMessage;
const result = (uuid: string | undefined, sessionId: string): SDKMessage =>
	({
		type: "result",
		subtype: "success",
		user_message_uuid: uuid,
		result: "done",
		uuid: "result",
		session_id: sessionId,
	}) as unknown as SDKMessage;

function pumpFixture() {
	const query = new ScriptedQuery();
	let replayEnabled = false;
	overrideSessionRegistryBoundary({
		queryFactory: ({ options }) => {
			replayEnabled = options?.extraArgs?.["replay-user-messages"] === "";
			return query;
		},
	});
	const registry = new ClaudeSdkOauthSessionRegistry();
	const entry = registry.getOrCreate(input("pump-session"));
	return { query, registry, entry, replayEnabled };
}

async function submittedMessage(entry: { inputController: AsyncIterable<SDKUserMessage> }): Promise<SDKUserMessage> {
	const item = await entry.inputController[Symbol.asyncIterator]().next();
	if (item.done) throw new Error("Expected a submitted user message");
	return item.value;
}

function input(senpiSessionId: string) {
	return {
		senpiSessionId,
		accountName: "default",
		modelId: "claude-test",
		toolsetHash: "tools-v1",
		systemPromptHash: "prompt-v1",
		options: {},
	};
}

function fakeQuery(onClose?: () => void): SdkQueryHandle {
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
		async interrupt() {},
		close() {
			onClose?.();
		},
	};
}

afterEach(() => resetSessionRegistryBoundary());

describe("Claude SDK OAuth session registry", () => {
	it("creates queries lazily and reuses the resident entry", () => {
		let queries = 0;
		overrideSessionRegistryBoundary({
			queryFactory: () => {
				queries++;
				return fakeQuery();
			},
		});
		const registry = new ClaudeSdkOauthSessionRegistry();

		expect(registry.size).toBe(0);
		expect(queries).toBe(0);
		const first = registry.getOrCreate(input("session-a"));
		const second = registry.getOrCreate(input("session-a"));

		expect(first).toBe(second);
		expect(first.state).toBe("STARTING");
		expect(first.sdkSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(queries).toBe(1);
	});

	it.each(["shutdown", "new_session", "switch_session", "process_exit"])(
		"closes and removes a session for the %s reason",
		(reason) => {
			let closes = 0;
			overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery(() => closes++) });
			const registry = new ClaudeSdkOauthSessionRegistry();
			registry.getOrCreate(input("session-a"));

			registry.closeSession("session-a", reason);

			expect(closes).toBe(1);
			expect(registry.get("session-a")).toBeUndefined();
		},
	);

	it("makes close idempotent", () => {
		let closes = 0;
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery(() => closes++) });
		const registry = new ClaudeSdkOauthSessionRegistry();
		registry.getOrCreate(input("session-a"));

		expect(() => {
			registry.closeSession("session-a", "shutdown");
			registry.closeSession("session-a", "shutdown");
		}).not.toThrow();
		expect(closes).toBe(1);
	});

	it("evicts expired idle entries using the injected clock", () => {
		let now = 1_000;
		const closed: string[] = [];
		overrideSessionRegistryBoundary({
			now: () => now,
			queryFactory: ({ options }) => fakeQuery(() => closed.push(String(options?.sessionId))),
		});
		const registry = new ClaudeSdkOauthSessionRegistry();
		const expired = registry.getOrCreate(input("expired"));
		transitionSessionState(expired, "IDLE_SYNCED");
		now += SESSION_REGISTRY_IDLE_TTL_MS;

		registry.getOrCreate(input("fresh"));

		expect(registry.get("expired")).toBeUndefined();
		expect(closed).toEqual([expired.sdkSessionId]);
	});

	it("enforces the 32-entry cap by evicting the oldest idle or tainted entry", () => {
		let now = 0;
		overrideSessionRegistryBoundary({ now: () => now, queryFactory: () => fakeQuery() });
		const registry = new ClaudeSdkOauthSessionRegistry();
		for (let index = 0; index < 32; index++) {
			const entry = registry.getOrCreate(input(`session-${index}`));
			transitionSessionState(entry, "IDLE_SYNCED");
			if (index === 0) registry.markTainted(entry.senpiSessionId, "branch changed");
			now++;
		}

		registry.getOrCreate(input("session-32"));

		expect(registry.size).toBe(32);
		expect(registry.get("session-0")).toBeUndefined();
		expect(registry.get("session-1")?.state).toBe("IDLE_SYNCED");
	});

	it("never evicts an active turn when an older evictable entry exists", () => {
		let now = 0;
		overrideSessionRegistryBoundary({ now: () => now, queryFactory: () => fakeQuery() });
		const registry = new ClaudeSdkOauthSessionRegistry();
		const active = registry.getOrCreate(input("active"));
		transitionSessionState(active, "IDLE_SYNCED");
		transitionSessionState(active, "TURN_WAITING");
		for (let index = 1; index < 32; index++) {
			now++;
			const entry = registry.getOrCreate(input(`idle-${index}`));
			transitionSessionState(entry, "IDLE_SYNCED");
		}

		registry.getOrCreate(input("new"));

		expect(registry.get("active")).toBe(active);
		expect(registry.get("idle-1")).toBeUndefined();
	});

	it("rejects admission when all 32 resident entries have active turns", () => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
		const registry = new ClaudeSdkOauthSessionRegistry();
		for (let index = 0; index < 32; index++) {
			const entry = registry.getOrCreate(input(`active-${index}`));
			transitionSessionState(entry, "IDLE_SYNCED");
			transitionSessionState(entry, "TURN_WAITING");
		}

		expect(() => registry.getOrCreate(input("rejected"))).toThrow(SessionRegistryResourceLimitError);
		expect(registry.size).toBe(32);
		expect(registry.get("active-0")?.state).toBe("TURN_WAITING");
	});

	it("fences messages from a superseded generation", () => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
		const registry = new ClaudeSdkOauthSessionRegistry();
		const first = registry.getOrCreate(input("session-a"));
		expect(registry.isCurrentGeneration("session-a", first.generation)).toBe(true);
		registry.closeSession("session-a", "rotate");
		const second = registry.getOrCreate(input("session-a"));

		expect(second.generation).toBeGreaterThan(first.generation);
		expect(registry.isCurrentGeneration("session-a", first.generation)).toBe(false);
		expect(registry.isCurrentGeneration("session-a", second.generation)).toBe(true);
	});

	it("throws for illegal state transitions", () => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
		const entry = new ClaudeSdkOauthSessionRegistry().getOrCreate(input("session-a"));

		expect(() => transitionSessionState(entry, "TURN_STREAMING")).toThrow(/illegal session state transition/i);
	});

	it("round-trips assistant UUIDs and branch information", () => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
		const registry = new ClaudeSdkOauthSessionRegistry();
		const entry = registry.getOrCreate(input("session-a"));
		entry.assistantUuidByIndex.set(3, "assistant-uuid");
		registry.recordBranchInfo("session-a", { oldLeafId: "old", newLeafId: "new" });

		expect(entry.assistantUuidByIndex.get(3)).toBe("assistant-uuid");
		expect(entry.branchInfo).toEqual({ oldLeafId: "old", newLeafId: "new" });
	});

	it("reports whether the bound non-environment account token is expiring", () => {
		let now = 10_000;
		overrideSessionRegistryBoundary({ now: () => now, queryFactory: () => fakeQuery() });
		const entry = new ClaudeSdkOauthSessionRegistry().getOrCreate(input("session-a"));
		const accounts: AccountSlot[] = [
			{ name: "default", access: "a", refresh: "r", expires: now + 5 * 60_000, source: "login" },
		];

		expect(isBoundAccountTokenExpiring(entry, accounts)).toBe(true);
		now--;
		expect(isBoundAccountTokenExpiring(entry, accounts)).toBe(false);
	});

	it("claims a turn from the replayed submitted uuid", async () => {
		const { query, registry, entry, replayEnabled } = pumpFixture();
		const turn = submitSessionTurn(registry, entry, { message: userContent });
		const submitted = await submittedMessage(entry);
		expect(replayEnabled).toBe(true);
		expect(submitted.uuid).toMatch(/-7[0-9a-f]{3}-/);
		expect(submitted.session_id).toBe(entry.sdkSessionId);
		query.emit(replay(submitted.uuid!, entry.sdkSessionId));
		query.emit(result(submitted.uuid, entry.sdkSessionId));
		expect((await turn).messages).toEqual([query.emitted[1]]);
	});

	it("buffers pre-replay stream events and flushes them in order", async () => {
		const { query, registry, entry } = pumpFixture();
		const turn = submitSessionTurn(registry, entry, { message: userContent });
		const submitted = await submittedMessage(entry);
		const first = streamEvent("stream-1", entry.sdkSessionId);
		const second = streamEvent("stream-2", entry.sdkSessionId);
		query.emit(first);
		query.emit(second);
		query.emit(replay(submitted.uuid!, entry.sdkSessionId));
		const terminal = result(submitted.uuid, entry.sdkSessionId);
		query.emit(terminal);
		expect((await turn).messages).toEqual([first, second, terminal]);
	});

	it("closes the query when the pre-replay buffer overflows", async () => {
		const { query, registry, entry } = pumpFixture();
		const turn = submitSessionTurn(registry, entry, { message: userContent }, { maxMessages: 1, maxBytes: 10_000 });
		query.emit(streamEvent("stream-1", entry.sdkSessionId));
		query.emit(streamEvent("stream-2", entry.sdkSessionId));
		await expect(turn).rejects.toThrow(/pre-replay buffer/i);
		expect(query.closes).toBe(1);
	});

	it("ends a claimed turn only at its result and returns to idle", async () => {
		const { query, registry, entry } = pumpFixture();
		const turn = submitSessionTurn(registry, entry, { message: userContent });
		const submitted = await submittedMessage(entry);
		query.emit(replay(submitted.uuid!, entry.sdkSessionId));
		query.emit(streamEvent("stream", entry.sdkSessionId));
		expect(entry.activeTurn).not.toBeNull();
		query.emit(result(submitted.uuid, entry.sdkSessionId));
		await turn;
		expect(entry.state).toBe("IDLE_SYNCED");
		expect(entry.activeTurn).toBeNull();
	});

	it("closes the query for a mismatched result user_message_uuid", async () => {
		const { query, registry, entry } = pumpFixture();
		const turn = submitSessionTurn(registry, entry, { message: userContent });
		const submitted = await submittedMessage(entry);
		query.emit(replay(submitted.uuid!, entry.sdkSessionId));
		query.emit(result("other-turn", entry.sdkSessionId));
		await expect(turn).rejects.toThrow(/result.*uuid/i);
		expect(query.closes).toBe(1);
	});

	it("interrupts once, finishes the aborted turn with partial content, and taints the entry", async () => {
		const { query, registry, entry } = pumpFixture();
		const abort = new AbortController();
		const turn = submitSessionTurn(registry, entry, { message: userContent, signal: abort.signal });
		const submitted = await submittedMessage(entry);
		query.emit(replay(submitted.uuid!, entry.sdkSessionId));
		const partial = streamEvent("partial", entry.sdkSessionId);
		query.emit(partial);
		abort.abort();
		abort.abort();
		query.emit(result(submitted.uuid, entry.sdkSessionId));
		const completed = await turn;
		expect(completed).toMatchObject({ aborted: true, messages: [partial] });
		expect(query.interrupts).toBe(1);
		expect(entry.state).toBe("TAINTED");
	});

	it("throws on a second concurrent turn admission", () => {
		const { registry, entry } = pumpFixture();
		void submitSessionTurn(registry, entry, { message: userContent });
		expect(() => submitSessionTurn(registry, entry, { message: userContent })).toThrow(
			ConcurrentSessionTurnAdmissionError,
		);
	});

	it("discards messages from a superseded generation", async () => {
		const oldQuery = new ScriptedQuery();
		const newQuery = new ScriptedQuery();
		let created = 0;
		overrideSessionRegistryBoundary({ queryFactory: () => (created++ === 0 ? oldQuery : newQuery) });
		const registry = new ClaudeSdkOauthSessionRegistry();
		const entry = registry.getOrCreate(input("superseded"));
		const delivered: SDKMessage[] = [];
		const turn = submitSessionTurn(registry, entry, {
			message: userContent,
			onMessage: (message) => delivered.push(message),
		});
		const submitted = await submittedMessage(entry);
		registry.closeSession(entry.senpiSessionId, "superseded");
		registry.getOrCreate(input(entry.senpiSessionId));
		oldQuery.emit(replay(submitted.uuid!, entry.sdkSessionId));
		oldQuery.emit(streamEvent("stale", entry.sdkSessionId));
		oldQuery.emit(result(submitted.uuid, entry.sdkSessionId));
		oldQuery.finish();
		await expect(turn).rejects.toThrow(/ended/i);
		expect(delivered).toEqual([]);
		expect(newQuery.closes).toBe(0);
	});
});
