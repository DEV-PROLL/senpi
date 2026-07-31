import type { Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildPromptBlocks, buildPromptStream } from "../src/core/extensions/builtin/claude-sdk-oauth/prompt-bridge.ts";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const events: T[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("Claude SDK OAuth prompt bridge", () => {
	it("bridges mixed history to one exact SDK user message", async () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Find it" },
						{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
					],
					timestamp: 1,
				},
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "repoSearch", arguments: { query: "needle" } }],
					api: "claude-sdk-oauth",
					provider: "claude-sdk-oauth",
					model: "claude-test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "repoSearch",
					content: [{ type: "text", text: "match" }],
					isError: false,
					timestamp: 3,
				},
			],
		};
		const blocks = buildPromptBlocks(
			context,
			new Map([["repoSearch", "mcp__custom-tools__repoSearch"]]),
			"recovered",
		);
		expect(await collect(buildPromptStream(blocks))).toEqual([
			{
				type: "user",
				parent_tool_use_id: null,
				session_id: "prompt",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "USER:\n" },
						{ type: "text", text: "Find it" },
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
						{ type: "text", text: "\n\nASSISTANT:\n" },
						{
							type: "text",
							text: 'Historical tool call (non-executable): mcp__custom-tools__repoSearch args={"query":"needle"}',
						},
						{ type: "text", text: "\n\nTOOL RESULT (historical mcp__custom-tools__repoSearch, id=call-1):\n" },
						{ type: "text", text: "match" },
						{ type: "text", text: "\n\nRECOVERED TOOL RESULTS:\n" },
						{ type: "text", text: "recovered" },
					],
				},
			},
		]);
	});
});
