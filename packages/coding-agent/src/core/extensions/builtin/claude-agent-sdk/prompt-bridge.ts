import type { AssistantMessage, Context, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Base64ImageSource, ContentBlockParam, SDKUserMessage } from "./sdk-boundary.ts";

const PI_TO_SDK_TOOL_NAME: Readonly<Record<string, string>> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	bash: "Bash",
	grep: "Grep",
	find: "Glob",
	glob: "Glob",
};

type PromptContent = string | readonly (TextContent | ImageContent)[];

function pascalCase(value: string): string {
	return value
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
		.join("");
}

export function mapPiToolNameToSdk(name: string, customToolNameToSdk?: ReadonlyMap<string, string>): string {
	const normalized = name.toLowerCase();
	const custom = customToolNameToSdk?.get(name) ?? customToolNameToSdk?.get(normalized);
	return custom ?? PI_TO_SDK_TOOL_NAME[normalized] ?? pascalCase(name);
}

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
	const pushPrefix = (label: string): void => {
		pushText(`${blocks.length ? "\n\n" : ""}${label}\n`);
	};

	for (const message of context.messages) {
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

	if (toolWatchNote?.trim()) {
		pushPrefix("RECOVERED TOOL RESULTS:");
		pushText(toolWatchNote.trim());
	}
	return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
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
