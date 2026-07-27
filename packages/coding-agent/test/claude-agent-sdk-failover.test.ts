import { type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type AccountSlot,
	addAccount,
	type ClaudeAgentSdkCredential,
	emptyCredential,
} from "../src/core/extensions/builtin/claude-agent-sdk/accounts.ts";
import { rendezvousOrder, selectAccount } from "../src/core/extensions/builtin/claude-agent-sdk/affinity.ts";
import { classifySdkError } from "../src/core/extensions/builtin/claude-agent-sdk/errors.ts";
import { ClassifiedSdkError, runFailover } from "../src/core/extensions/builtin/claude-agent-sdk/failover.ts";

type AttemptEvent =
	| { type: "text_delta"; delta: string }
	| { type: "toolcall_delta"; delta: string }
	| { type: "done"; value: string };

const accountPool: AccountSlot[] = [
	{ name: "alpha", refresh: "r-alpha", access: "a-alpha", expires: 1, source: "login" },
	{ name: "bravo", refresh: "r-bravo", access: "a-bravo", expires: 1, source: "login" },
	{ name: "charlie", refresh: "r-charlie", access: "a-charlie", expires: 1, source: "login" },
];
const now = 10_000;

async function storeWithAccounts(): Promise<CredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify("claude-agent-sdk", async () =>
		accountPool.reduce<ClaudeAgentSdkCredential>(
			(credential, account) => addAccount(credential, account),
			emptyCredential(),
		),
	);
	return store;
}

async function collect(iterable: AsyncIterable<AttemptEvent>): Promise<AttemptEvent[]> {
	const events: AttemptEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

describe("Claude Agent SDK failover", () => {
	it("classifies all SDK error values and HTTP 429/529 equivalents", () => {
		expect(classifySdkError("authentication_failed")).toEqual({ kind: "auth_error", retryable: true });
		expect(classifySdkError("oauth_org_not_allowed")).toEqual({ kind: "org_not_allowed", retryable: false });
		expect(classifySdkError("billing_error")).toEqual({ kind: "billing", retryable: false });
		expect(classifySdkError("rate_limit")).toEqual({ kind: "rate_limit", retryable: true });
		expect(classifySdkError("overloaded")).toEqual({ kind: "overloaded", retryable: true });
		expect(classifySdkError("invalid_request")).toEqual({ kind: "other", retryable: false });
		expect(classifySdkError("server_error")).toEqual({ kind: "other", retryable: true });
		expect(classifySdkError("HTTP 429 too many requests")).toEqual({ kind: "rate_limit", retryable: true });
		expect(classifySdkError("HTTP 529 overloaded")).toEqual({ kind: "overloaded", retryable: true });
	});

	it("walks HRW order after a rate limit, persists the cooldown, and emits failover", async () => {
		const store = await storeWithAccounts();
		const sessionId = "failover-session";
		const expected = rendezvousOrder(sessionId, accountPool).map((account) => account.name);
		const attempts: string[] = [];
		const failovers: string[] = [];
		const events = await collect(
			runFailover({
				accounts: accountPool,
				selectFn: (pool) => selectAccount(pool, { sessionId, now }),
				runAttempt: async function* (slot) {
					attempts.push(slot.name);
					if (attempts.length === 1) throw new Error("rate_limit retry-after-ms: 2500");
					yield { type: "done", value: slot.name };
				},
				classify: classifySdkError,
				store,
				providerId: "claude-agent-sdk",
				now: () => now,
				onFailover: (event) => {
					failovers.push(`${event.account.name}:${event.classification.kind}`);
				},
			}),
		);

		expect(attempts).toEqual(expected.slice(0, 2));
		expect(events).toEqual([{ type: "done", value: expected[1] }]);
		expect(failovers).toEqual([`${expected[0]}:rate_limit`]);
		const credential = (await store.read("claude-agent-sdk")) as ClaudeAgentSdkCredential;
		const blocked = credential.accounts?.find((account) => account.name === expected[0]);
		expect(blocked).toMatchObject({ blockReason: "rate_limit", blockedUntil: now + 2_500 });
	});

	it("does not transparently retry after text or a tool-call delta, but still blocks and emits failover", async () => {
		const store = await storeWithAccounts();
		const attempts: string[] = [];
		const failovers: string[] = [];
		const stream = runFailover({
			accounts: accountPool,
			selectFn: (pool) => selectAccount(pool, { sessionId: "post-delta", now }),
			runAttempt: async function* (slot) {
				attempts.push(slot.name);
				const textDelta: AttemptEvent = { type: "text_delta", delta: "partial" };
				const toolDelta: AttemptEvent = { type: "toolcall_delta", delta: '{"path":"x"}' };
				yield textDelta;
				yield toolDelta;
				throw new Error("rate_limit");
			},
			classify: classifySdkError,
			store,
			providerId: "claude-agent-sdk",
			now: () => now,
			onFailover: (event) => {
				failovers.push(event.account.name);
			},
		});
		const emitted: AttemptEvent[] = [];
		await expect(
			(async () => {
				for await (const event of stream) emitted.push(event);
			})(),
		).rejects.toMatchObject({
			name: "ClassifiedSdkError",
			classification: { kind: "rate_limit", retryable: true },
			suppressTurnRetry: true,
		});

		expect(emitted).toEqual([
			{ type: "text_delta", delta: "partial" },
			{ type: "toolcall_delta", delta: '{"path":"x"}' },
		]);
		expect(attempts).toHaveLength(1);
		expect(failovers).toEqual(attempts);
		const credential = (await store.read("claude-agent-sdk")) as ClaudeAgentSdkCredential;
		expect(credential.accounts?.find((account) => account.name === attempts[0])).toMatchObject({
			blockReason: "rate_limit",
		});
	});

	it("blocks authentication failures until re-login instead of assigning a time-based expiry", async () => {
		const store = await storeWithAccounts();
		const stream = runFailover({
			accounts: [accountPool[0]!],
			selectFn: (pool) => selectAccount(pool, { sessionId: "auth", now }),
			runAttempt: async function* (slot) {
				if (slot.name === accountPool[0]!.name) throw new Error("authentication_failed");
				const done: AttemptEvent = { type: "done", value: slot.name };
				yield done;
			},
			classify: classifySdkError,
			store,
			providerId: "claude-agent-sdk",
			now: () => now,
		});
		await expect(collect(stream)).rejects.toBeInstanceOf(ClassifiedSdkError);
		const credential = (await store.read("claude-agent-sdk")) as ClaudeAgentSdkCredential;
		expect(credential.accounts?.[0]).toMatchObject({ blockReason: "auth_error" });
		expect(credential.accounts?.[0]?.blockedUntil).toBeUndefined();
	});
});
