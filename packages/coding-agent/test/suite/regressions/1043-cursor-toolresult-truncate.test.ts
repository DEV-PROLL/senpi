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
		const toolText = messageText(next[2]);
		expect(next[2]).toBe(original);
		expect(toolText).toBe(`${"a".repeat(1985)}\n...[truncated]`);
		expect([...toolText].length).toBeLessThanOrEqual(2000);
		expect(toolText).not.toContain("\ud800");
	});

	it("bounds the aggregate UTF-8 payload across all tool results", () => {
		const messages = Array.from({ length: 100 }, (_, index) =>
			textMessage("toolResult", `${index}:${"가".repeat(2000)}`),
		);
		const original = messages[0];
		const { messages: next, changed } = truncateToolResultBodies(messages);
		expect(changed).toBe(true);
		expect(next?.[0]).toBe(original);
		if (!next) throw new Error("expected messages");
		const bytes = new TextEncoder().encode(next.map(messageText).join("")).byteLength;
		expect(bytes).toBeLessThanOrEqual(50_000);
	});

	it("is a no-op when every toolResult is already short", () => {
		const messages = [textMessage("toolResult", "ok")];
		const { changed } = truncateToolResultBodies(messages, CURSOR_TOOL_RESULT_MAX_CHARS);
		expect(changed).toBe(false);
	});
});
