import type { Tool } from "../../../types.ts";
import type { ParsedToolCall, ParserOptions } from "../../types.ts";
import {
	parseXtmlAttributes,
	XTML_ARGUMENT_CLOSE,
	XTML_ARGUMENT_OPEN,
	XTML_CALL_CLOSE,
	XTML_CALL_OPEN,
	XTML_SEP,
	XTML_TOOLS_CLOSE,
	XTML_TOOLS_OPEN,
} from "./markers.ts";

type CoercedValue = { ok: true; value: unknown } | { ok: false };

export function coerceXtmlArgumentValue(raw: string, type: string | undefined): CoercedValue {
	switch (type) {
		case undefined:
		case "string":
			return { ok: true, value: raw };
		case "number": {
			const parsed = Number(raw);
			return Number.isNaN(parsed) ? { ok: false } : { ok: true, value: parsed };
		}
		case "boolean":
			if (raw === "true") return { ok: true, value: true };
			if (raw === "false") return { ok: true, value: false };
			return { ok: false };
		case "object":
		case "array":
			try {
				return { ok: true, value: JSON.parse(raw) };
			} catch {
				return { ok: false };
			}
		default:
			return { ok: true, value: raw };
	}
}

function parseCallBody(
	body: string,
	tool: Tool,
	options?: ParserOptions,
): Record<string, unknown> | null {
	const args: Record<string, unknown> = {};
	let rest = body;
	for (;;) {
		rest = rest.replace(/^\s+/, "");
		if (!rest.startsWith(XTML_ARGUMENT_OPEN)) break;
		const headerEnd = rest.indexOf(XTML_SEP, XTML_ARGUMENT_OPEN.length);
		if (headerEnd === -1) break;
		const attributes = parseXtmlAttributes(rest.slice(XTML_ARGUMENT_OPEN.length, headerEnd));
		const key = attributes.key;
		const valueStart = headerEnd + XTML_SEP.length;
		const valueEnd = rest.indexOf(XTML_ARGUMENT_CLOSE, valueStart);
		if (valueEnd === -1 || !key) break;
		const coerced = coerceXtmlArgumentValue(rest.slice(valueStart, valueEnd), attributes.type);
		if (!coerced.ok) {
			options?.onError?.(`kimi-xtml: invalid value for argument "${key}" on tool "${tool.name}".`, {
				toolCall: rest.slice(0, valueEnd + XTML_ARGUMENT_CLOSE.length),
			});
			return null;
		}
		args[key] = coerced.value;
		rest = rest.slice(valueEnd + XTML_ARGUMENT_CLOSE.length);
	}
	return args;
}

export function parseKimiXtmlGeneratedText(text: string, tools: Tool[], options?: ParserOptions): ParsedToolCall[] {
	const parsed: ParsedToolCall[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const blockStart = text.indexOf(XTML_TOOLS_OPEN, cursor);
		if (blockStart === -1) break;
		const bodyStart = blockStart + XTML_TOOLS_OPEN.length;
		const blockEnd = text.indexOf(XTML_TOOLS_CLOSE, bodyStart);
		const block = blockEnd === -1 ? text.slice(bodyStart) : text.slice(bodyStart, blockEnd);
		cursor = blockEnd === -1 ? text.length : blockEnd + XTML_TOOLS_CLOSE.length;

		let callCursor = 0;
		while (callCursor < block.length) {
			const callStart = block.indexOf(XTML_CALL_OPEN, callCursor);
			if (callStart === -1) break;
			const headerEnd = block.indexOf(XTML_SEP, callStart + XTML_CALL_OPEN.length);
			if (headerEnd === -1) break;
			const attributes = parseXtmlAttributes(block.slice(callStart + XTML_CALL_OPEN.length, headerEnd));
			const bodyEnd = block.indexOf(XTML_CALL_CLOSE, headerEnd + XTML_SEP.length);
			const callBody = bodyEnd === -1 ? block.slice(headerEnd + XTML_SEP.length) : block.slice(headerEnd + XTML_SEP.length, bodyEnd);
			callCursor = bodyEnd === -1 ? block.length : bodyEnd + XTML_CALL_CLOSE.length;

			const name = attributes.tool;
			const tool = name ? tools.find((candidate) => candidate.name === name) : undefined;
			if (!tool) {
				options?.onError?.(`kimi-xtml: call for unknown tool "${name ?? ""}".`, { toolCall: callBody });
				continue;
			}
			const args = parseCallBody(callBody, tool, options);
			if (args) parsed.push({ name: tool.name, arguments: args });
		}
	}
	return parsed;
}
