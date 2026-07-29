import type { ImageContent, TextContent, Tool } from "../../../types.ts";
import {
	XTML_ARGUMENT_CLOSE,
	XTML_ARGUMENT_OPEN,
	XTML_CALL_CLOSE,
	XTML_SEP,
	XTML_TOOLS_CLOSE,
	XTML_TOOLS_OPEN,
} from "./markers.ts";

function inferXtmlType(value: unknown): string {
	if (typeof value === "number") return "number";
	if (typeof value === "boolean") return "boolean";
	if (Array.isArray(value)) return "array";
	if (typeof value === "object" && value !== null) return "object";
	return "string";
}

function serializeXtmlValue(value: unknown, type: string): string {
	if (type === "object" || type === "array") return JSON.stringify(value);
	return String(value);
}

export function kimiXtmlFormatToolCall(name: string, args: Record<string, unknown>): string {
	const renderedArgs = Object.entries(args)
		.map(([key, value]) => {
			const type = inferXtmlType(value);
			return `${XTML_ARGUMENT_OPEN}key="${key}" type="${type}"${XTML_SEP}${serializeXtmlValue(value, type)}${XTML_ARGUMENT_CLOSE}`;
		})
		.join("");
	return `${XTML_TOOLS_OPEN}${"<|open|>call "}tool="${name}" index="1"${XTML_SEP}${renderedArgs}${XTML_CALL_CLOSE}${XTML_TOOLS_CLOSE}`;
}

export function kimiXtmlFormatToolResponse(
	toolName: string,
	_toolCallId: string,
	content: (TextContent | ImageContent)[],
): string {
	const text = content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	return `## Return of ${toolName}\n${text}`;
}

export function kimiXtmlFormatToolsSystemPrompt(tools: Tool[]): string {
	if (tools.length === 0) return "";
	const toolDescriptions = tools
		.map((tool) => `Name: ${tool.name}\nDescription: ${tool.description}\nParameters Schema:\n${JSON.stringify(tool.parameters, null, 3)}`)
		.join("\n\n");
	return `You have access to the following tools. Use them when appropriate.

${toolDescriptions}

When you need to use a tool, format your response exactly like this, with no other text inside the tools block:

${XTML_TOOLS_OPEN}${"<|open|>call "}tool="tool_name" index="1"${XTML_SEP}${XTML_ARGUMENT_OPEN}key="param" type="string"${XTML_SEP}value${XTML_ARGUMENT_CLOSE}${XTML_CALL_CLOSE}${XTML_TOOLS_CLOSE}

Formatting rules:
- Emit one ${"<|open|>call "}...${XTML_CALL_CLOSE} section per tool call inside a single tools block.
- Argument types: string (default when type is omitted), number, boolean, object, array.
- object and array values must be strict JSON; string values are raw text and need no quoting.
- Example: ${XTML_TOOLS_OPEN}${"<|open|>call "}tool="get_weather" index="1"${XTML_SEP}${XTML_ARGUMENT_OPEN}key="city" type="string"${XTML_SEP}Seoul${XTML_ARGUMENT_CLOSE}${XTML_CALL_CLOSE}${XTML_TOOLS_CLOSE}`;
}
