import type { AssistantMessage, TextContent, ThinkingContent } from "@earendil-works/pi-ai/compat";

export type TrailingAssistantSplit = {
	head: AssistantMessage["content"];
	tail: Array<TextContent | ThinkingContent>;
};

export function splitTrailingAssistantContent(content: AssistantMessage["content"]): TrailingAssistantSplit {
	let lastTool = -1;
	for (let i = 0; i < content.length; i++) {
		if (content[i]?.type === "toolCall") {
			lastTool = i;
		}
	}
	if (lastTool < 0 || lastTool === content.length - 1) {
		return { head: content, tail: [] };
	}
	const tail = content
		.slice(lastTool + 1)
		.filter((block): block is TextContent | ThinkingContent => block.type === "text" || block.type === "thinking");
	if (tail.length === 0) {
		return { head: content, tail: [] };
	}
	return { head: content.slice(0, lastTool + 1), tail };
}
