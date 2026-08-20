import { describe, expect, it } from "vitest";
import { splitTrailingAssistantContent } from "../../../src/modes/interactive/split-trailing-assistant-text.ts";

describe("splitTrailingAssistantContent", () => {
	it("parks text after the last toolCall in tail", () => {
		const { head, tail } = splitTrailingAssistantContent([
			{ type: "text", text: "exploring" },
			{ type: "toolCall", id: "t1", name: "eval", arguments: {} },
			{ type: "text", text: "진행할까요?" },
		]);
		expect(head.map((block) => block.type)).toEqual(["text", "toolCall"]);
		expect(tail).toHaveLength(1);
		expect(tail[0]).toMatchObject({ type: "text", text: "진행할까요?" });
	});

	it("keeps a text-only message intact", () => {
		const content = [{ type: "text", text: "only" } as const];
		const split = splitTrailingAssistantContent(content);
		expect(split.tail).toEqual([]);
		expect(split.head).toEqual(content);
	});
});
