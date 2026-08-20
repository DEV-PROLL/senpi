import { describe, expect, it } from "vitest";
import { promoteStopWithPendingToolCalls, shouldTerminateAssistantTurn } from "../src/assistant-terminal-state.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";

function msg(stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		stopReason,
		content,
		api: "cursor-agent",
		provider: "cursor",
		model: "claude-fable-5-medium",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: 0,
	} as AssistantMessage;
}

describe("promoteStopWithPendingToolCalls", () => {
	it("promotes stop with toolCalls to toolUse", () => {
		const next = promoteStopWithPendingToolCalls(
			msg("stop", [
				{ type: "text", text: "ok" },
				{ type: "toolCall", id: "1", name: "eval", arguments: {} },
			] as AssistantMessage["content"]),
		);
		expect(next.stopReason).toBe("toolUse");
		expect(shouldTerminateAssistantTurn(next)).toBe(false);
	});

	it("leaves text-only stop alone", () => {
		const next = promoteStopWithPendingToolCalls(msg("stop", [{ type: "text", text: "done" }] as AssistantMessage["content"]));
		expect(next.stopReason).toBe("stop");
	});
});
