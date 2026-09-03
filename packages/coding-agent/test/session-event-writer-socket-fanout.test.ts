import { describe, expect, it } from "vitest";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";

type StalledConnection = {
	writes: string[];
	closed: number;
	writeRaw(chunk: string): void;
	waitForBackpressure(): Promise<void>;
	release(): void;
	close(): void;
};

/** A socket client whose reader never keeps up until `release()` is called. */
function stalledConnection(): StalledConnection {
	let pending: (() => void) | undefined;
	return {
		writes: [],
		closed: 0,
		writeRaw(chunk) {
			this.writes.push(chunk);
		},
		waitForBackpressure() {
			return new Promise<void>((resolve) => {
				pending = resolve;
			});
		},
		release() {
			pending?.();
			pending = undefined;
		},
		close() {
			this.closed += 1;
		},
	};
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const textDelta = (delta: string, text: string) => ({
	type: "message_update",
	message: { role: "assistant", content: [{ type: "text", text }] },
	assistantMessageEvent: {
		type: "text_delta",
		contentIndex: 0,
		delta,
		partial: { role: "assistant", content: [{ type: "text", text }] },
	},
});

describe("SessionEventWriter socket fan-out under a stalled reader", () => {
	it("delivers every text delta; superseded snapshots go out delta-only", async () => {
		// Given: one socket client attached to a session, stalled behind a barrier.
		const writer = new SessionEventWriter(() => {});
		const connection = stalledConnection();
		writer.registerConnection("socket-1", connection);
		writer.attachConnectionToSession("socket-1", "rpc-1");
		writer.enqueue("rpc-1", { type: "message_start", message: { role: "assistant", content: [] } });
		expect(connection.writes).toHaveLength(1);

		// When: three cumulative message_update snapshots queue up before it drains.
		writer.enqueue("rpc-1", textDelta("ULTRAWORK ", "ULTRAWORK "));
		writer.enqueue("rpc-1", textDelta("MODE ", "ULTRAWORK MODE "));
		writer.enqueue("rpc-1", textDelta("ENABLED", "ULTRAWORK MODE ENABLED"));
		for (let i = 0; i < 5; i++) {
			connection.release();
			await settle();
		}

		// Then: the client can rebuild the full text from deltas - the two
		// superseded records arrive with message/partial blanked but delta intact,
		// and only the last one carries the snapshot. (Before: only "ENABLED"
		// reached the wire and the desktop rendered "ENABLED" as the whole message.)
		const updates = connection.writes
			.slice(1)
			.map((line) => JSON.parse(line) as { message: unknown; assistantMessageEvent: { delta: string; partial: unknown } });
		expect(updates.map((update) => update.assistantMessageEvent.delta)).toEqual(["ULTRAWORK ", "MODE ", "ENABLED"]);
		expect(updates.map((update) => update.message === null)).toEqual([true, true, false]);
		expect(updates.map((update) => update.assistantMessageEvent.partial === null)).toEqual([true, true, false]);
	});

	it("closes the connection when its event queue overflows", async () => {
		// Given: a client whose queue cap is tiny, so one burst overflows it.
		const writer = new SessionEventWriter(() => {});
		const connection = stalledConnection();
		writer.registerConnection("socket-1", connection, { maxQueueBytes: 1024 });
		writer.attachConnectionToSession("socket-1", "rpc-1");
		writer.enqueue("rpc-1", { type: "message_start", message: { role: "assistant", content: [] } });

		// When: an oversized tool result (an inline image, in production several
		// MiB of base64) lands behind the stalled barrier.
		writer.enqueue("rpc-1", {
			type: "tool_execution_end",
			toolCallId: "t1",
			result: { content: [{ type: "image", data: "x".repeat(2048) }] },
		});

		// Then: the client is told to resync AND its transport is torn down, so it
		// reconnects instead of waiting forever on a connection the host stopped
		// serving (records and command responses alike).
		expect(connection.writes.at(-1)).toBe('{"type":"overflow","error":"overflow, resync required"}\n');
		expect(connection.closed).toBe(1);
		expect(writer.hasCapableConnection("rpc-1")).toBe(false);
	});
});
