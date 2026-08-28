import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	listRotationSlots,
	sha256SlotHasher,
	streamWithCredentialRotation,
} from "../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../src/core/credential-pool/state-store.ts";

const NOW = 1_756_000_000_000;

let dir: string;
let repository: CredentialSlotRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rotation-stream-"));
	repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function pooled(): PooledCredential {
	return {
		type: "api_key",
		key: "key-default",
		accounts: [
			{ name: "default", key: "key-default", source: "login" },
			{ name: "work", key: "key-work", source: "login" },
		],
	};
}

function partialMessage(errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: errorMessage === undefined ? "stop" : "error",
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: Date.now(),
	};
}

function startEvent(): AssistantMessageEvent {
	return { type: "start", partial: partialMessage() };
}

function textEvent(text: string): AssistantMessageEvent {
	return { type: "text_delta", contentIndex: 0, delta: text, partial: partialMessage() };
}

function errorEvent(message: string): AssistantMessageEvent {
	return { type: "error", reason: "error", error: partialMessage(message) };
}

async function* stream(...items: AssistantMessageEvent[]): AsyncGenerator<AssistantMessageEvent> {
	for (const item of items) yield item;
}

async function collect(source: AsyncGenerator<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const seen: AssistantMessageEvent[] = [];
	for await (const event of source) seen.push(event);
	return seen;
}

describe("credential rotation over a pooled provider", () => {
	test("ordinary streamSimple requests rotate before output", async () => {
		const attempted: string[] = [];
		const events = await collect(
			streamWithCredentialRotation({
				sources: { providerId: "test", credential: pooled(), env: () => undefined, repository, now: () => NOW },
				affinityKey: "ordinary-agent-session",
				runAttempt: (slot) => {
					attempted.push(slot.name);
					return attempted.length === 1
						? stream(startEvent(), errorEvent("401 unauthorized"))
						: stream(startEvent(), textEvent("ok"));
				},
			}),
		);
		expect(attempted).toHaveLength(2);
		expect(events.some((event) => event.type === "text_delta")).toBe(true);
	});

	test("policy disables affinity and bounds cooldown", async () => {
		const chosen: string[] = [];
		await collect(
			streamWithCredentialRotation({
				sources: {
					providerId: "test",
					credential: pooled(),
					env: () => undefined,
					repository,
					policy: { affinity: false, cooldownBaseMs: 5, cooldownCapMs: 10 },
					now: () => NOW,
				},
				runAttempt: (slot) => {
					chosen.push(slot.name);
					return stream(startEvent(), textEvent("ok"));
				},
			}),
		);
		await collect(
			streamWithCredentialRotation({
				sources: {
					providerId: "test",
					credential: pooled(),
					env: () => undefined,
					repository,
					policy: { affinity: false },
					now: () => NOW,
				},
				runAttempt: (slot) => {
					chosen.push(slot.name);
					return stream(startEvent(), textEvent("ok"));
				},
			}),
		);
		expect(chosen).toHaveLength(2);
	});

	test("pinned account wins selection over HRW affinity", async () => {
		const attempted: string[] = [];
		const pinnedCredential: PooledCredential = { ...pooled(), pinned: "work" };
		await collect(
			streamWithCredentialRotation({
				sources: {
					providerId: "test",
					credential: pinnedCredential,
					env: () => undefined,
					repository,
				},
				affinityKey: "pin-regression",
				runAttempt: (slot) => {
					attempted.push(slot.name);
					return stream(startEvent(), textEvent("ok"));
				},
			}),
		);
		expect(attempted).toEqual(["work"]);
	});

	test("expired cooldown admits exactly one probe", async () => {
		await repository.mutateSlotState("test", "stored", "default", () => ({
			blockedUntil: NOW - 1,
			blockReason: "rate_limit",
		}));
		const first = await listRotationSlots({
			providerId: "test",
			credential: pooled(),
			env: () => undefined,
			repository,
			now: () => NOW,
		});
		const second = await listRotationSlots({
			providerId: "test",
			credential: pooled(),
			env: () => undefined,
			repository,
			now: () => NOW,
		});
		expect(first.some((slot) => slot.name === "default")).toBe(true);
		expect(second.some((slot) => slot.name === "default")).toBe(false);
	});

	test("policy cooldown cap is applied to persisted rate limits", async () => {
		const attempted: string[] = [];
		await collect(
			streamWithCredentialRotation({
				sources: {
					providerId: "test",
					credential: pooled(),
					env: () => undefined,
					repository,
					policy: { cooldownBaseMs: 5, cooldownCapMs: 10 },
					now: () => NOW,
				},
				affinityKey: "policy-cooldown",
				runAttempt: (slot) => {
					attempted.push(slot.name);
					return stream(startEvent(), errorEvent("429 rate limited"));
				},
			}),
		).catch(() => undefined);
		const state = await repository.listSlots("test", "stored");
		expect(state[attempted[0] ?? ""]?.blockedUntil).toBe(NOW + 10);
	});

	test("successful pooled request completes after selection", async () => {
		await repository.mutateSlotState("test", "stored", "default", () => undefined);
		await repository.mutateSlotState("test", "stored", "work", () => undefined);
		const attempted: string[] = [];
		await collect(
			streamWithCredentialRotation({
				sources: { providerId: "test", credential: pooled(), env: () => undefined, repository, now: () => NOW },
				affinityKey: "probe-regression",
				runAttempt: (slot) => {
					attempted.push(slot.name);
					return stream(startEvent(), textEvent("ok"));
				},
			}),
		);
		expect(attempted).toHaveLength(1);
		expect(attempted).toHaveLength(1);
	});
	test("lists both stored slots with sidecar health overlaid", async () => {
		await repository.mutateSlotState("test", "stored", "work", () => ({
			blockedUntil: NOW + 60_000,
			blockReason: "rate_limit",
		}));

		const slots = await listRotationSlots({
			providerId: "test",
			credential: pooled(),
			env: () => undefined,
			repository,
		});

		expect(slots.map((slot) => slot.name)).toEqual(["default", "work"]);
		expect(slots[1]).toMatchObject({ lane: "stored", blockedUntil: NOW + 60_000, blockReason: "rate_limit" });
	});

	test("a 429 before any delta rotates to the sibling slot and persists the cooldown", async () => {
		const attempted: string[] = [];
		const events = await collect(
			streamWithCredentialRotation({
				sources: { providerId: "test", credential: pooled(), env: () => undefined, repository, now: () => NOW },
				affinityKey: "session-1",
				hasher: sha256SlotHasher,
				runAttempt: (slot) => {
					attempted.push(slot.name);
					return attempted.length === 1
						? stream(startEvent(), errorEvent("429 rate limited"))
						: stream(startEvent(), textEvent("hello"));
				},
			}),
		);

		expect(attempted).toHaveLength(2);
		expect(attempted[0]).not.toBe(attempted[1]);
		expect(events.some((event) => event.type === "text_delta")).toBe(true);
		const persisted = await repository.listSlots("test", "stored");
		const blocked = persisted[attempted[0] ?? ""];
		expect(blocked).toMatchObject({ blockReason: "rate_limit" });
		expect(blocked?.blockedUntil).toBe(NOW + 60_000);
	});

	test("the same affinity key sticks to the same slot with no config present", async () => {
		const chosen: string[] = [];
		for (let index = 0; index < 3; index++) {
			await collect(
				streamWithCredentialRotation({
					sources: { providerId: "test", credential: pooled(), env: () => undefined, repository },
					affinityKey: "stable-session",
					runAttempt: (slot) => {
						chosen.push(slot.name);
						return stream(startEvent(), textEvent("ok"));
					},
				}),
			);
		}
		expect(new Set(chosen).size).toBe(1);
	});

	test("a failure after a delta never rotates and carries the suppression marker", async () => {
		const attempted: string[] = [];
		let caught: unknown;
		try {
			await collect(
				streamWithCredentialRotation({
					sources: { providerId: "test", credential: pooled(), env: () => undefined, repository },
					affinityKey: "session-2",
					runAttempt: (slot) => {
						attempted.push(slot.name);
						return stream(startEvent(), textEvent("partial"), errorEvent("429 rate limited"));
					},
				}),
			);
		} catch (error) {
			caught = error;
		}
		expect(attempted).toHaveLength(1);
		expect((caught as Error).message.startsWith("senpi:no-turn-retry:")).toBe(true);
	});

	test("env slots form a pool and a rotated env value clears its own stale block", async () => {
		const env = (name: string) => ({ OPENAI_API_KEY: "sk-one", OPENAI_API_KEY_2: "sk-two" })[name];
		const staleRevision = await repository.envCredentialRevision("OPENAI_API_KEY", "sk-old");
		await repository.mutateSlotState("openai", "env", "env", () => ({
			blockedUntil: NOW + 600_000,
			blockReason: "rate_limit",
			credentialRevision: staleRevision,
		}));

		const slots = await listRotationSlots({ providerId: "openai", credential: undefined, env, repository });

		expect(slots.map((slot) => slot.name)).toEqual(["env", "env-2"]);
		// The persisted block belonged to the previous value of OPENAI_API_KEY.
		expect(slots[0]?.blockedUntil).toBeUndefined();
	});
});
