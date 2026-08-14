import { describe, expect, it } from "vitest";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";
import { SessionExtensionUiRequests } from "../src/modes/rpc/session-extension-ui-requests.ts";

function records(chunks: readonly string[]): Array<Record<string, unknown>> {
	return chunks
		.join("")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function cumulativeTextUpdate(delta: string, text: string, contentIndex = 0): Record<string, unknown> {
	return {
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex,
			delta,
			partial: { role: "assistant", content: [{ type: "text", text }] },
		},
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

function flushedDeltas(output: readonly Record<string, unknown>[]): string {
	return output
		.filter((record) => record.type === "message_update")
		.map((record) => (record.assistantMessageEvent as { delta?: string }).delta ?? "")
		.join("");
}

describe("multi-session RPC event writer", () => {
	it("compacts 1000 stalled message snapshots without losing assistant transitions", () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);
		const source = Array.from({ length: 1000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join("");
		let cumulative = "";
		let cumulativeBytes = 0;

		writer.enqueue("a", { type: "message_start", message: { role: "assistant", content: [] } });
		for (const delta of source) {
			cumulative += delta;
			const update = cumulativeTextUpdate(delta, cumulative);
			cumulativeBytes += Buffer.byteLength(JSON.stringify({ ...update, sessionId: "a" }) + "\n");
			writer.enqueue("a", update);
		}
		writer.enqueue("a", {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: source }] },
		});
		scheduled[0]!();

		const output = records(chunks);
		const updates = output.filter((record) => record.type === "message_update");
		expect(output[0]?.type).toBe("message_start");
		expect(output.at(-1)?.type).toBe("message_end");
		expect(flushedDeltas(output)).toBe(source);
		expect(updates.at(-1)?.message).toEqual({
			role: "assistant",
			content: [{ type: "text", text: source }],
		});
		expect(updates.slice(0, -1).every((record) => record.message === null)).toBe(true);
		expect(Buffer.byteLength(chunks.join(""))).toBeLessThan(cumulativeBytes / 20);
	});

	it("latest-wins coalesces tool progress independently by toolCallId", () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);

		writer.enqueue("a", { type: "tool_execution_start", toolCallId: "A" });
		writer.enqueue("a", { type: "tool_execution_update", toolCallId: "A", partialResult: "A1" });
		writer.enqueue("a", { type: "tool_execution_update", toolCallId: "B", partialResult: "B1" });
		writer.enqueue("a", { type: "tool_execution_update", toolCallId: "A", partialResult: "A2" });
		writer.enqueue("a", { type: "tool_execution_update", toolCallId: "B", partialResult: "B2" });
		writer.enqueue("a", { type: "tool_execution_end", toolCallId: "A" });
		scheduled[0]!();

		expect(
			records(chunks).map(({ type, toolCallId, partialResult }) => ({ type, toolCallId, partialResult })),
		).toEqual([
			{ type: "tool_execution_start", toolCallId: "A", partialResult: undefined },
			{ type: "tool_execution_update", toolCallId: "A", partialResult: "A2" },
			{ type: "tool_execution_update", toolCallId: "B", partialResult: "B2" },
			{ type: "tool_execution_end", toolCallId: "A", partialResult: undefined },
		]);
	});

	it("does not merge across assistant or protocol barriers", () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);

		writer.enqueue("a", cumulativeTextUpdate("a", "a"));
		writer.enqueue("a", cumulativeTextUpdate("b", "ab"));
		writer.enqueue("a", {
			type: "message_update",
			assistantMessageEvent: { type: "text_end", contentIndex: 0 },
			message: {},
		});
		writer.enqueue("a", cumulativeTextUpdate("c", "abc"));
		writer.enqueue("a", cumulativeTextUpdate("d", "abcd"));
		writer.enqueue("a", { type: "extension_ui_request", id: "ui" });
		writer.enqueue("a", cumulativeTextUpdate("e", "abcde"));
		writer.enqueue("a", cumulativeTextUpdate("f", "abcdef"));
		writer.enqueue("a", { type: "response", id: "command", success: true });
		writer.enqueue("a", cumulativeTextUpdate("g", "abcdefg"));
		writer.enqueue("a", cumulativeTextUpdate("h", "abcdefgh"));
		scheduled[0]!();

		const output = records(chunks);
		expect(output.map((record) => record.type)).toEqual([
			"message_update",
			"message_update",
			"message_update",
			"message_update",
			"message_update",
			"extension_ui_request",
			"message_update",
			"message_update",
			"response",
			"message_update",
			"message_update",
		]);
		expect(flushedDeltas(output)).toBe("abcdefgh");
		expect(
			output
				.filter((record) => record.type === "message_update")
				.map((record) => (record.assistantMessageEvent as { type: string }).type),
		).toEqual([
			"text_delta",
			"text_delta",
			"text_end",
			"text_delta",
			"text_delta",
			"text_delta",
			"text_delta",
			"text_delta",
			"text_delta",
		]);
	});

	it("never coalesces delta-only, error, lifecycle, or unknown records", () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);
		const barriers = [
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "delta-only" },
			},
			{ type: "extension_error", error: "boom" },
			{ type: "agent_settled" },
			{ type: "future_record", value: 1 },
		];

		barriers.forEach((barrier, index) => {
			const sessionId = `barrier-${index}`;
			writer.enqueue(sessionId, cumulativeTextUpdate("x", "x"));
			writer.enqueue(sessionId, barrier);
			writer.enqueue(sessionId, cumulativeTextUpdate("y", "xy"));
		});
		scheduled[0]!();

		const output = records(chunks);
		expect(output).toHaveLength(12);
		expect(output.filter((record) => record.message === null)).toHaveLength(0);
		expect(output.filter((record) => record.type === "message_update")).toHaveLength(9);
	});

	it("tags every record, preserves per-session FIFO, and round-robins complete records", () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);

		writer.enqueue("a", { type: "message_update", sequence: 1 });
		writer.enqueue("a", { type: "tool_execution_update", payload: "x".repeat(128 * 1024) });
		writer.enqueue("b", { type: "message_update", sequence: 1 });
		writer.enqueue("a", { type: "agent_settled", sequence: 2 });
		writer.enqueue("b", { type: "agent_settled", sequence: 2 });
		scheduled[0]!();

		expect(records(chunks)).toEqual([
			{ type: "message_update", sequence: 1, sessionId: "a" },
			{ type: "message_update", sequence: 1, sessionId: "b" },
			{ type: "tool_execution_update", payload: "x".repeat(128 * 1024), sessionId: "a" },
			{ type: "agent_settled", sequence: 2, sessionId: "b" },
			{ type: "agent_settled", sequence: 2, sessionId: "a" },
		]);
		// Each complete record is its own raw write: sessions are never coalesced.
		expect(chunks).toHaveLength(5);
	});

	it("routes extension UI responses only to that session's pending map and rejects pending work on close", () => {
		const a = new SessionExtensionUiRequests();
		const b = new SessionExtensionUiRequests();
		let resolvedA = false;
		let resolvedB = false;
		let rejectedA = false;
		a.set("request", { resolve: () => (resolvedA = true), reject: () => (rejectedA = true) });
		b.set("request", { resolve: () => (resolvedB = true), reject: () => {} });

		expect(a.resolve({ type: "extension_ui_response", id: "request", value: "A" })).toBe(true);
		expect(resolvedA).toBe(true);
		expect(resolvedB).toBe(false);
		a.set("closing", { resolve: () => {}, reject: () => (rejectedA = true) });
		a.close();
		expect(rejectedA).toBe(true);
		expect(a.resolve({ type: "extension_ui_response", id: "closing", value: "late" })).toBe(false);
		expect(b.resolve({ type: "extension_ui_response", id: "request", value: "B" })).toBe(true);
		expect(resolvedB).toBe(true);
	});

	it("does not emit after a session is sealed, while allowing its terminal close response", () => {
		const chunks: string[] = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => flush(),
		);

		writer.enqueue("a", { type: "message_update" });
		writer.closeSession("a", { id: "close-a", type: "response", command: "close_session", success: true });
		writer.enqueue("a", { type: "agent_settled" });
		writer.enqueue("b", { type: "agent_settled" });
		writer.flush();

		expect(records(chunks)).toEqual([
			{ type: "message_update", sessionId: "a" },
			{ id: "close-a", type: "response", command: "close_session", success: true, sessionId: "a" },
			{ type: "agent_settled", sessionId: "b" },
		]);
	});
});
