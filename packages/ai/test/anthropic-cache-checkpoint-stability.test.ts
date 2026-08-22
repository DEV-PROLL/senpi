import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildAnthropicWarmPromptCacheParams } from "../src/api/anthropic-messages.ts";
import { getBuiltinModel as getModel } from "../src/providers/all.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/providers/faux.ts";
import type { Context, ToolResultMessage } from "../src/types.ts";

const FIRST_TOOL_USE_ID = "toolu_first";
const SECOND_TOOL_USE_ID = "toolu_second";
const THIRD_TOOL_USE_ID = "toolu_third";

function toolResultMessage(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: `${toolCallId} result` }],
		isError: false,
		timestamp: 1,
	};
}

function markedToolResultIds(params: ReturnType<typeof buildAnthropicWarmPromptCacheParams>): string[] {
	const markedIds: string[] = [];
	for (const message of params.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "tool_result" && block.cache_control !== undefined) {
				markedIds.push(block.tool_use_id);
			}
		}
	}
	return markedIds;
}

function cacheBreakpointCount(params: ReturnType<typeof buildAnthropicWarmPromptCacheParams>): number {
	return JSON.stringify(params).match(/"cache_control"/g)?.length ?? 0;
}

describe("Anthropic cache checkpoints", () => {
	it("retains the preceding tool-result checkpoint while marking a new tool-result tail", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const firstToolLoop: Context = {
			systemPrompt: "You are concise.",
			messages: [
				{ role: "user", content: "Inspect the repository", timestamp: 1 },
				fauxAssistantMessage(fauxToolCall("read", {}, { id: FIRST_TOOL_USE_ID }), { stopReason: "toolUse" }),
				toolResultMessage(FIRST_TOOL_USE_ID),
			],
			tools: [{ name: "read", description: "Read a file", parameters: Type.Object({}) }],
		};
		const secondToolLoop: Context = {
			...firstToolLoop,
			messages: [
				...firstToolLoop.messages,
				fauxAssistantMessage(fauxToolCall("read", {}, { id: SECOND_TOOL_USE_ID }), { stopReason: "toolUse" }),
				toolResultMessage(SECOND_TOOL_USE_ID),
			],
		};
		const thirdToolLoop: Context = {
			...secondToolLoop,
			messages: [
				...secondToolLoop.messages,
				fauxAssistantMessage(fauxToolCall("read", {}, { id: THIRD_TOOL_USE_ID }), { stopReason: "toolUse" }),
				toolResultMessage(THIRD_TOOL_USE_ID),
			],
		};

		expect(markedToolResultIds(buildAnthropicWarmPromptCacheParams(model, firstToolLoop))).toEqual([FIRST_TOOL_USE_ID]);
		expect(markedToolResultIds(buildAnthropicWarmPromptCacheParams(model, secondToolLoop))).toEqual([
			FIRST_TOOL_USE_ID,
			SECOND_TOOL_USE_ID,
		]);
		expect(markedToolResultIds(buildAnthropicWarmPromptCacheParams(model, thirdToolLoop))).toEqual([
			SECOND_TOOL_USE_ID,
			THIRD_TOOL_USE_ID,
		]);
		expect(cacheBreakpointCount(buildAnthropicWarmPromptCacheParams(model, thirdToolLoop))).toBe(4);
	});
});
