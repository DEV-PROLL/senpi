import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildCursorHistoryForTest } from "@earendil-works/pi-ai/api/cursor-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	CURSOR_TOOL_RESULT_MAX_BYTES,
	CURSOR_TOOL_RESULT_MAX_CHARS,
	truncateToolResultBodies,
} from "../../../src/core/agent-session.ts";
import { createHarness, type Harness } from "../harness.ts";

function textMessage(role: AgentMessage["role"], text: string): AgentMessage {
	return { role, content: [{ type: "text", text }] } as AgentMessage;
}

function messageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) throw new Error("expected content message");
	const part = content[0] as { type?: string; text?: string } | undefined;
	if (part?.type !== "text" || typeof part.text !== "string") throw new Error("expected text part");
	return part.text;
}

function toolResult(text: string, id: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	} as AgentMessage;
}

function cursorPairedMessages(resultTexts: string[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const [index, text] of resultTexts.entries()) {
		const id = `call-${index}`;
		messages.push({ role: "user", content: `request ${index}`, timestamp: 0 } as AgentMessage);
		messages.push({
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: { path: "a.ts" } }],
			api: "cursor-agent",
			provider: "cursor",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		} as AgentMessage);
		messages.push(toolResult(text, id));
	}
	messages.push({ role: "user", content: "continue", timestamp: 0 } as AgentMessage);
	return messages;
}

function serializedCursorHistoryBytes(messages: AgentMessage[]): number {
	const history = buildCursorHistoryForTest(messages as never);
	return (
		new TextEncoder().encode(JSON.stringify(history.rootPromptMessagesJson)).byteLength +
		new TextEncoder().encode(JSON.stringify(history.turnUserMessagesJson)).byteLength +
		new TextEncoder().encode(JSON.stringify(history.turnStepMessagesJson)).byteLength
	);
}

describe("1043 cursor toolResult truncate", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});
	it("caps long toolResult text at a code-point-safe, marker-inclusive boundary", () => {
		const messages = [
			textMessage("user", "진행해"),
			textMessage("assistant", "ok".repeat(5000)),
			textMessage("toolResult", `${"a".repeat(1998)}😀tail`),
		];
		const original = messages[2];
		const { messages: next, changed } = truncateToolResultBodies(messages, 2000);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(messageText(next[1]).length).toBe(10_000);
		expect(next[2]).not.toBe(original);
		expect(messageText(messages[2])).toBe(`${"a".repeat(1998)}😀tail`);
		const toolText = messageText(next[2]);
		expect(toolText).toMatch(/^a+\n\.\.\.\[truncated\]$/);
		expect(toolText.length).toBeLessThanOrEqual(2000);
		expect([...toolText].length).toBeLessThanOrEqual(2000);
		expect(toolText).not.toContain("\ud800");
	});

	it("bounds the aggregate UTF-8 payload across all tool results", () => {
		const messages = Array.from({ length: 100 }, (_, index) =>
			textMessage("toolResult", `${index}:${"가".repeat(2000)}`),
		);
		const { messages: next, changed } = truncateToolResultBodies(messages);
		expect(changed).toBe(true);
		if (!next) throw new Error("expected messages");
		expect(messageText(next[99])).toMatch(/^99:가+\n\.\.\.\[truncated\]$/);
		expect(messageText(next[0])).toContain("...[truncated]");
		const bytes = new TextEncoder().encode(next.map(messageText).join("")).byteLength;
		expect(bytes).toBeLessThanOrEqual(50_000);
	});

	it("reserves marker budget before the full-part fast path (review reproduction)", () => {
		const messages = [
			toolResult("x".repeat(100), "old"),
			toolResult("가".repeat(2000), "cjk-0"),
			toolResult("가".repeat(2000), "cjk-1"),
			toolResult("가".repeat(2000), "cjk-2"),
			toolResult("가".repeat(2000), "cjk-3"),
			toolResult("가".repeat(2000), "cjk-4"),
			toolResult("가".repeat(2000), "cjk-5"),
			toolResult("가".repeat(2000), "cjk-6"),
			toolResult("가".repeat(2000), "cjk-7"),
			toolResult("n".repeat(1990), "newest"),
		];
		const { messages: next } = truncateToolResultBodies(messages);
		if (!next) throw new Error("expected messages");
		const bytes = new TextEncoder().encode(
			next
				.flatMap((message) =>
					message.role === "toolResult"
						? message.content.filter((part) => part.type === "text").map((part) => part.text)
						: [],
				)
				.join(""),
		).byteLength;
		expect(bytes).toBeLessThanOrEqual(CURSOR_TOOL_RESULT_MAX_BYTES);
	});

	it("uses truncated request messages for overflow sizing while persistence stays full", async () => {
		const harness = await createHarness({ provider: "cursor", models: [{ id: "cursor", contextWindow: 100_000 }] });
		harnesses.push(harness);
		const fullText = "payload ".repeat(20_000);
		const persisted = toolResult(fullText, "persisted");
		harness.sessionManager.appendMessage(persisted as never);
		harness.agent.state.messages = [persisted];
		const transformed = await harness.agent.transformContext?.([persisted]);
		expect(JSON.stringify(transformed)).not.toContain(fullText);
		expect(JSON.stringify(harness.sessionManager.getEntries())).toContain(fullText);

		const entries = harness.sessionManager.getEntries();
		const compacted = (harness.session as any)._wouldCompactionOverflow(
			entries,
			{ summary: "summary", firstKeptEntryId: entries[0]?.id, tokensBefore: 0, details: {} },
			false,
			harness.getModel(),
		);
		expect(compacted).toBe(false);
	});

	it("bounds the duplicated decoded Cursor root and turn history for CJK results", () => {
		const messages = cursorPairedMessages(Array.from({ length: 8 }, () => "界".repeat(2000)));
		const rawBytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
		expect(rawBytes).toBeGreaterThan(48_000);
		const { messages: next } = truncateToolResultBodies(messages);
		if (!next) throw new Error("expected messages");
		expect(serializedCursorHistoryBytes(next)).toBeLessThanOrEqual(CURSOR_TOOL_RESULT_MAX_BYTES);
	});

	it("keeps grapheme clusters intact and retains a marker when only marker space remains", () => {
		const messages = [textMessage("toolResult", "👩‍💻e\u0301".repeat(10))];
		const { messages: next } = truncateToolResultBodies(messages, 4, 20);
		const text = next ? messageText(next[0]) : "";
		expect(text).toContain("...[truncated]");
		expect(text).not.toMatch(/👩(?:$|[^‍])/u);
		expect(text).not.toMatch(/e$/u);
	});

	it("is a no-op when every toolResult is already short", () => {
		const messages = [textMessage("toolResult", "ok")];
		const { changed } = truncateToolResultBodies(messages, CURSOR_TOOL_RESULT_MAX_CHARS);
		expect(changed).toBe(false);
	});
});
