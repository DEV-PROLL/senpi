/**
 * Wire-contract provenance pins for the connection-router audit (findings 1, 4, 8).
 *
 * All three findings are the same shape: a field or an event that MUST cross the RPC
 * boundary was never added to the wire contract, so an attached client cannot
 * reconstruct authoritative host state. Each is pinned in-process against the real
 * `createRpcConnectionHandler` with a real `AgentSession` from the suite harness — no
 * child process is spawned, so these tests do not contend with the host-spawning suites.
 *
 *  1. Session replacement is not broadcast to other attached clients.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createRpcConnectionHandler, type RpcConnectionSink } from "../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type RpcRecord = Record<string, unknown>;

interface CollectedSink {
	sink: RpcConnectionSink;
	messages: () => readonly RpcRecord[];
	waitFor: (predicate: (message: RpcRecord) => boolean, timeoutMs?: number) => Promise<RpcRecord>;
}

function makeSink(): CollectedSink {
	const records: RpcRecord[] = [];
	const waiters: Array<{ predicate: (message: RpcRecord) => boolean; resolve: (message: RpcRecord) => void }> = [];
	let buffer = "";

	const dispatch = (record: RpcRecord) => {
		records.push(record);
		for (const waiter of [...waiters]) {
			if (!waiter.predicate(record)) continue;
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve(record);
		}
	};

	return {
		sink: {
			writeRaw(chunk) {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line) dispatch(JSON.parse(line) as RpcRecord);
					newline = buffer.indexOf("\n");
				}
			},
			waitForBackpressure: async () => {},
		},
		messages: () => records,
		waitFor(predicate, timeoutMs = 5_000) {
			const existing = records.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				let waiter!: (typeof waiters)[number];
				const timer = setTimeout(() => {
					const index = waiters.indexOf(waiter);
					if (index !== -1) waiters.splice(index, 1);
					reject(new Error("Timed out waiting for the expected RPC record"));
				}, timeoutMs);
				waiter = {
					predicate,
					resolve: (message) => {
						clearTimeout(timer);
						resolve(message);
					},
				};
				waiters.push(waiter);
			});
		},
	};
}

/**
 * A runtime host whose `session` getter is swappable and whose `setRebindSession`
 * callback is captured, so a replacement can be driven exactly the way
 * `AgentSessionRuntime` drives one: swap the live session, then invoke the callback.
 */
function makeRuntimeHost(initial: AgentSession): {
	runtimeHost: AgentSessionRuntime;
	replaceWith: (next: AgentSession) => Promise<void>;
} {
	let live = initial;
	let rebind: (() => Promise<void>) | undefined;
	const runtimeHost = {
		get session() {
			return live;
		},
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn((callback?: () => Promise<void>) => {
			rebind = callback;
		}),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		replaceWith: async (next) => {
			live = next;
			await rebind?.();
		},
	};
}

describe("RPC wire provenance", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});

	async function newHarness(): Promise<Harness> {
		const harness = await createHarness({ models: [{ id: "provenance-model", reasoning: true }] });
		harnesses.push(harness);
		return harness;
	}

	// Finding 1 -----------------------------------------------------------------
	it("broadcasts the replacement identity to an attached client after a runtime session swap", async () => {
		const first = await newHarness();
		const second = await newHarness();
		const collected = makeSink();
		const host = makeRuntimeHost(first.session);
		const handler = createRpcConnectionHandler(host.runtimeHost, collected.sink);
		await handler.ready;

		const replaced = collected.waitFor((record) => record.type === "session_replaced");
		await host.replaceWith(second.session);

		// An attached client that did not issue the replacement must be told the live
		// binding moved, and must be given the new authoritative identity so it can
		// resync without guessing. Without this it keeps routing at the old session.
		expect(await replaced).toMatchObject({
			type: "session_replaced",
			sessionId: second.session.sessionId,
			cwd: second.session.sessionManager.getCwd(),
		});
		expect(second.session.sessionId).not.toBe(first.session.sessionId);

		await handler.dispose();
	});
});
