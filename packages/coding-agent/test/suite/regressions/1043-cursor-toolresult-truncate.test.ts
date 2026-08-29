import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { CURSOR_TOOL_RESULT_MAX_CHARS, truncateToolResultBodies } from "../../../src/core/agent-session.ts";

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

describe("1043 cursor toolResult truncate", () => {
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
