import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	createEmergencyPruneLatch,
	hardLimitEmergencyPrune,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMessage(text: string, timestamp: number): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantToolCall(id: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: { command: `echo ${id}` } }],
		api: "faux-completion",
		provider: "faux",
		model: "faux-model",
		usage: emptyUsage(),
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResultText(id: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

/**
 * The cacheable prefix the provider sees. Any change to an older message
 * invalidates the prompt cache from that message onward, so byte-equality of
 * this serialization across consecutive requests is exactly what decides
 * whether the provider can reuse its cached prefix.
 */
function serializeShape(messages: AgentMessage[]): string {
	return JSON.stringify(messages);
}

/**
 * A long-running session that parks near the emergency threshold: an oversized
 * tool result early in the history, then one small turn appended per request.
 * `growth` walks the estimate across the engage threshold and back, which is
 * what a polling loop does when each turn adds a little and pruning removes it.
 */
function buildHistory(extraTurns: number): AgentMessage[] {
	const oversized = `${"A".repeat(9_000)}MID-SENTINEL-7f3a1c${"B".repeat(9_000)}`;
	const messages: AgentMessage[] = [
		userMessage("initial request", 1),
		assistantToolCall("call-1", 2),
		toolResultText("call-1", oversized, 3),
	];
	for (let index = 0; index < extraTurns; index++) {
		messages.push(assistantToolCall(`poll-${index}`, 100 + index * 2));
		messages.push(toolResultText(`poll-${index}`, `poll result ${index}`, 101 + index * 2));
	}
	messages.push(userMessage("latest request", 9_000));
	return messages;
}

describe("emergency prune hysteresis", () => {
	it("keeps the cacheable prefix stable while the estimate oscillates around the engage threshold", () => {
		// Given a fixed conversation prefix and a session whose estimated size drifts
		// back and forth across the engage threshold between consecutive requests.
		const history = buildHistory(0);
		const totalEstimate = 18_035;
		// windows chosen so the estimate lands just above the engage ratio, then just
		// below it (but still above the release ratio) -- the exact parked-at-the-limit
		// condition that made a real session re-bill its whole prompt every turn.
		const oscillatingWindows = [
			Math.ceil(totalEstimate / 0.95) - 10, // estimate > engage -> prune
			Math.ceil(totalEstimate / 0.9), // estimate < engage, > release -> must stay pruned
			Math.ceil(totalEstimate / 0.95) - 10,
			Math.ceil(totalEstimate / 0.9),
			Math.ceil(totalEstimate / 0.88),
		];
		const latch = createEmergencyPruneLatch();

		// When each request runs through the shared latch.
		const shapes = oscillatingWindows.map((contextWindow) =>
			serializeShape(hardLimitEmergencyPrune(history, contextWindow, latch).messages),
		);

		// Then every emitted shape is identical, so the provider prompt-cache prefix
		// survives. With a single threshold these alternate and the cache is re-billed.
		expect(new Set(shapes).size).toBe(1);
	});

	it("releases the latch once the context drops well below the engage threshold", () => {
		// Given a latch that has already engaged on an oversized context.
		const contextWindow = 5_000;
		const latch = createEmergencyPruneLatch();
		hardLimitEmergencyPrune(buildHistory(0), contextWindow, latch);

		// When a compaction shrinks the history far below the release threshold.
		const smallHistory: AgentMessage[] = [
			userMessage("post-compaction summary", 1),
			assistantToolCall("call-9", 2),
			toolResultText("call-9", "small result", 3),
			userMessage("latest request", 4),
		];
		const result = hardLimitEmergencyPrune(smallHistory, contextWindow, latch);

		// Then the messages pass through untouched again.
		expect(result.needsAggressiveCompaction).toBe(false);
		expect(serializeShape(result.messages)).toBe(serializeShape(smallHistory));
	});
});
