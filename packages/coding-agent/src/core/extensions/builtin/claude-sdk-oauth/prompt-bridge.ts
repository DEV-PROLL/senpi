import type { AssistantMessage, Context, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Base64ImageSource, ContentBlockParam, SDKUserMessage } from "./sdk-boundary.ts";
import { mapPiToolNameToSdk } from "./tools.ts";

export { mapPiToolNameToSdk } from "./tools.ts";

type PromptContent = string | readonly (TextContent | ImageContent)[];

export function contentToText(
	content: AssistantMessage["content"],
	customToolNameToSdk?: ReadonlyMap<string, string>,
): string {
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "thinking") return block.thinking;
			if (block.type === "toolCall") {
				return `Historical tool call (non-executable): ${mapPiToolNameToSdk(block.name, customToolNameToSdk)} args=${JSON.stringify(block.arguments)}`;
			}
			return `[${block.type}]`;
		})
		.join("\n");
}

function appendContentBlocks(blocks: ContentBlockParam[], content: PromptContent): boolean {
	if (typeof content === "string") {
		if (content.length > 0) blocks.push({ type: "text", text: content });
		return content.trim().length > 0;
	}

	let hasText = false;
	for (const block of content) {
		if (block.type === "text") {
			blocks.push({ type: "text", text: block.text });
			hasText ||= block.text.trim().length > 0;
		} else {
			blocks.push({
				type: "image",
				source: {
					type: "base64",
					media_type: block.mimeType as Base64ImageSource["media_type"],
					data: block.data,
				},
			});
		}
	}
	return hasText;
}

export function buildPromptBlocks(
	context: Context,
	customToolNameToSdk?: ReadonlyMap<string, string>,
	toolWatchNote?: string,
): ContentBlockParam[] {
	const blocks: ContentBlockParam[] = [];
	const pushText = (text: string): void => {
		blocks.push({ type: "text", text });
	};
	const finalMessage = context.messages.at(-1);
	const finalUserMessage = finalMessage?.role === "user" ? finalMessage : undefined;
	const history = finalUserMessage ? context.messages.slice(0, -1) : context.messages;

	if (history.length > 0) {
		pushText("<conversation_history>\n");
		let hasPreviousTurn = false;
		const pushPrefix = (label: string): void => {
			pushText(`${hasPreviousTurn ? "\n\n" : ""}${label}\n`);
			hasPreviousTurn = true;
		};

		for (const message of history) {
			if (message.role === "user") {
				pushPrefix("USER:");
				if (!appendContentBlocks(blocks, message.content)) pushText("(see attached image)");
				continue;
			}
			if (message.role === "assistant") {
				pushPrefix("ASSISTANT:");
				const text = contentToText(message.content, customToolNameToSdk);
				if (text.length > 0) pushText(text);
				continue;
			}
			pushPrefix(
				`TOOL RESULT (historical ${mapPiToolNameToSdk(message.toolName, customToolNameToSdk)}, id=${message.toolCallId}):`,
			);
			if (!appendContentBlocks(blocks, message.content)) pushText("(see attached image)");
		}
		pushText("\n</conversation_history>");
	}

	if (toolWatchNote?.trim()) {
		pushText("<recovered_tool_results>\n");
		pushText(toolWatchNote.trim());
		pushText("\n</recovered_tool_results>");
	}
	pushText(
		'The above is the conversation history so far, provided as context. Respond as the assistant to the user message below only. Never emit "USER:" or "ASSISTANT:" labels or continue the transcript.',
	);
	if (finalUserMessage && !appendContentBlocks(blocks, finalUserMessage.content)) pushText("(see attached image)");
	return blocks;
}

export function buildPromptStream(promptBlocks: ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
	return (async function* () {
		yield {
			type: "user",
			message: { role: "user", content: promptBlocks } as SDKUserMessage["message"],
			parent_tool_use_id: null,
			session_id: "prompt",
		};
	})();
}
