import { describe, expect, it } from "vitest";
import { recoverKimiXtmlThinking } from "../../src/tool-call-middleware/protocols/kimi-xtml/thinking-recovery.ts";
import type { AssistantMessage } from "../../src/types.ts";

function messageWithThinking(thinking: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "test-provider",
		model: "kimi-k3",
		content: [{ type: "thinking", thinking }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function thinkingText(message: AssistantMessage): string {
	return message.content
		.filter((item) => item.type === "thinking")
		.map((item) => (item.type === "thinking" ? item.thinking : ""))
		.join("");
}

function visibleText(message: AssistantMessage): string {
	return message.content
		.filter((item) => item.type === "text")
		.map((item) => (item.type === "text" ? item.text : ""))
		.join("");
}

describe("recoverKimiXtmlThinking", () => {
	it("strips tools-channel and unnamed markers from thinking", () => {
		// given
		const message = messageWithThinking("private<|close|>tools<|sep|> reasoning<|close|><|sep|> remains<|sep|>");

		// when
		const recovered = recoverKimiXtmlThinking(message);

		// then
		expect(thinkingText(recovered)).toBe("private reasoning remains");
		expect(visibleText(recovered)).toBe("");
		expect(recovered.content.map((item) => JSON.stringify(item)).join("")).not.toContain("<|");
		expect(recovered.diagnostics).toEqual([
			{
				type: "kimi_xtml_thinking_recovery",
				timestamp: expect.any(Number),
				details: { recoveredResponse: false },
			},
		]);
	});

	it("still promotes response content while stripping adjacent tools markers", () => {
		// given
		const message = messageWithThinking(
			"private<|close|>think<|sep|><|close|>tools<|sep|><|open|>response<|sep|>visible<|close|>response<|sep|>",
		);

		// when
		const recovered = recoverKimiXtmlThinking(message);

		// then
		expect(thinkingText(recovered)).toBe("private");
		expect(visibleText(recovered)).toBe("visible");
		expect(recovered.content.map((item) => JSON.stringify(item)).join("")).not.toContain("<|");
	});

	it("preserves tools and unnamed marker literals inside fenced code", () => {
		// given
		const literal = "Example:\n```text\n<|close|>tools<|sep|><|close|><|sep|>\n```";
		const message = messageWithThinking(literal);

		// when
		const recovered = recoverKimiXtmlThinking(message);

		// then
		expect(recovered).toBe(message);
		expect(thinkingText(recovered)).toBe(literal);
		expect(recovered.diagnostics).toBeUndefined();
	});
});
