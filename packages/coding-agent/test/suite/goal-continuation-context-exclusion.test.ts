import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { type CustomMessage, convertToLlm, filterContextExcludedMessages } from "../../src/core/messages.ts";

const GOAL_CONTINUATION_MESSAGE_TYPE = "goal-continuation";

function goalContinuation(content: string, timestamp: number): CustomMessage {
	return {
		role: "custom",
		customType: GOAL_CONTINUATION_MESSAGE_TYPE,
		content,
		display: false,
		timestamp,
	};
}

function customMessage(content: string, timestamp: number): CustomMessage {
	return {
		role: "custom",
		customType: "test-note",
		content,
		display: false,
		timestamp,
	};
}

function llmText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => (block.type === "text" ? block.text : "[non-text]")).join("");
}

function continuationContents(messages: AgentMessage[]): string[] {
	return messages.flatMap((message) =>
		message.role === "custom" && message.customType === GOAL_CONTINUATION_MESSAGE_TYPE
			? [typeof message.content === "string" ? message.content : "[non-text]"]
			: [],
	);
}

describe("goal-continuation context exclusion", () => {
	test.each([
		{ name: "zero", messages: [] as AgentMessage[], expected: [] as string[] },
		{
			name: "one",
			messages: [goalContinuation("live continuation", 1)] as AgentMessage[],
			expected: ["live continuation"],
		},
		{
			name: "many",
			messages: [
				goalContinuation("stale continuation one", 1),
				goalContinuation("stale continuation two", 2),
				goalContinuation("live continuation", 3),
			] as AgentMessage[],
			expected: ["live continuation"],
		},
	])("keeps only the last continuation when the array has $name", ({ messages, expected }) => {
		expect(continuationContents(filterContextExcludedMessages(messages))).toEqual(expected);
		expect(convertToLlm(messages).map(llmText)).toEqual(expected);
	});

	test("keeps non-goal messages and their ordering unchanged", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "before", timestamp: 1 },
			goalContinuation("stale continuation", 2),
			customMessage("non-goal custom", 3),
			goalContinuation("live continuation", 4),
			{ role: "user", content: "after", timestamp: 5 },
		];

		const filtered = filterContextExcludedMessages(messages);

		expect(filtered).toEqual([messages[0], messages[2], messages[3], messages[4]]);
		expect(convertToLlm(messages).map(llmText)).toEqual(["before", "non-goal custom", "live continuation", "after"]);
	});

	test("is idempotent across filtering and conversion", () => {
		const messages: AgentMessage[] = [
			goalContinuation("stale continuation", 1),
			customMessage("non-goal custom", 2),
			goalContinuation("live continuation", 3),
		];

		const filtered = filterContextExcludedMessages(messages);

		expect(filterContextExcludedMessages(filtered)).toEqual(filtered);
		expect(convertToLlm(filtered)).toEqual(convertToLlm(messages));
	});
});
