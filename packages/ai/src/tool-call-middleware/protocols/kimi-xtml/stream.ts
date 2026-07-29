import type { Tool } from "../../../types.ts";
import type { ParserOptions, StreamParser, StreamParserEvent } from "../../types.ts";
import {
	getPartialXtmlSuffix,
	parseXtmlAttributes,
	XTML_ARGUMENT_CLOSE,
	XTML_ARGUMENT_OPEN,
	XTML_CALL_CLOSE,
	XTML_CALL_OPEN,
	XTML_SEP,
	XTML_TOOLS_CLOSE,
	XTML_TOOLS_OPEN,
} from "./markers.ts";
import { coerceXtmlArgumentValue } from "./parse.ts";

type ParserMode = "text" | "tools" | "call-header" | "call-body" | "argument-header" | "argument-value" | "discard-call";

const TEXT_BOUNDARY_TOKENS = [XTML_TOOLS_OPEN] as const;
const TOOLS_BOUNDARY_TOKENS = [XTML_CALL_OPEN, XTML_TOOLS_CLOSE] as const;

export function createKimiXtmlStreamParser(tools: Tool[], options?: ParserOptions): StreamParser {
	let buffer = "";
	let mode: ParserMode = "text";
	let callIndex = -1;
	let callName = "";
	let callArgs: Record<string, unknown> = {};
	let callStarted = false;
	let callInvalidReason: string | null = null;
	let argumentKey = "";
	let argumentType: string | undefined;

	function resetCall(): void {
		callName = "";
		callArgs = {};
		callStarted = false;
		callInvalidReason = null;
		argumentKey = "";
		argumentType = undefined;
	}

	function startCall(events: StreamParserEvent[], name: string): void {
		callIndex += 1;
		callName = name;
		callStarted = true;
		events.push({ type: "toolcall_start", index: callIndex, name, id: `kimi-xtml-tool-${callIndex}` });
	}

	function endCall(events: StreamParserEvent[], incomplete: boolean): void {
		if (!callStarted) {
			resetCall();
			return;
		}
		const event: StreamParserEvent = {
			type: "toolcall_end",
			index: callIndex,
			name: callName,
			id: `kimi-xtml-tool-${callIndex}`,
			arguments: callArgs,
		};
		if (incomplete) {
			event.incomplete = true;
			if (callInvalidReason) event.errorMessage = callInvalidReason;
		}
		events.push(event);
		resetCall();
		mode = "tools";
	}

	function hold(events: StreamParserEvent[], tokens: readonly string[], flushAsText: boolean): void {
		const partial = getPartialXtmlSuffix(buffer, tokens);
		if (!flushAsText) return;
		const flushable = partial ? buffer.slice(0, -partial.length) : buffer;
		if (flushable) events.push({ type: "text", text: flushable });
		buffer = partial;
	}

	function process(events: StreamParserEvent[]): void {
		for (;;) {
			if (mode === "text") {
				const start = buffer.indexOf(XTML_TOOLS_OPEN);
				if (start === -1) {
					hold(events, TEXT_BOUNDARY_TOKENS, true);
					return;
				}
				if (start > 0) events.push({ type: "text", text: buffer.slice(0, start) });
				buffer = buffer.slice(start + XTML_TOOLS_OPEN.length);
				mode = "tools";
				continue;
			}
			if (mode === "tools") {
				const callStart = buffer.indexOf(XTML_CALL_OPEN);
				const toolsEnd = buffer.indexOf(XTML_TOOLS_CLOSE);
				if (toolsEnd !== -1 && (callStart === -1 || toolsEnd < callStart)) {
					buffer = buffer.slice(toolsEnd + XTML_TOOLS_CLOSE.length);
					mode = "text";
					continue;
				}
				if (callStart === -1) {
					hold(events, TOOLS_BOUNDARY_TOKENS, false);
					return;
				}
				buffer = buffer.slice(callStart + XTML_CALL_OPEN.length);
				mode = "call-header";
				continue;
			}
			if (mode === "call-header" || mode === "argument-header") {
				const sepIndex = buffer.indexOf(XTML_SEP);
				if (sepIndex === -1) {
					hold(events, [XTML_SEP], false);
					return;
				}
				const attributes = parseXtmlAttributes(buffer.slice(0, sepIndex));
				buffer = buffer.slice(sepIndex + XTML_SEP.length);
				if (mode === "call-header") {
					const name = attributes.tool ?? "";
					if (!tools.some((candidate) => candidate.name === name)) {
						options?.onError?.(`kimi-xtml: call for unknown tool "${name}".`, {});
						mode = "discard-call";
						continue;
					}
					startCall(events, name);
					mode = "call-body";
					continue;
				}
				argumentKey = attributes.key ?? "";
				argumentType = attributes.type;
				mode = "argument-value";
				continue;
			}
			if (mode === "call-body") {
				const argStart = buffer.indexOf(XTML_ARGUMENT_OPEN);
				const callEnd = buffer.indexOf(XTML_CALL_CLOSE);
				if (callEnd !== -1 && (argStart === -1 || callEnd < argStart)) {
					buffer = buffer.slice(callEnd + XTML_CALL_CLOSE.length);
					endCall(events, callInvalidReason !== null);
					continue;
				}
				if (argStart === -1) {
					hold(events, [XTML_ARGUMENT_OPEN, XTML_CALL_CLOSE], false);
					return;
				}
				buffer = buffer.slice(argStart + XTML_ARGUMENT_OPEN.length);
				mode = "argument-header";
				continue;
			}
			if (mode === "argument-value") {
				const valueEnd = buffer.indexOf(XTML_ARGUMENT_CLOSE);
				if (valueEnd === -1) {
					hold(events, [XTML_ARGUMENT_CLOSE], false);
					return;
				}
				const coerced = coerceXtmlArgumentValue(buffer.slice(0, valueEnd), argumentType);
				buffer = buffer.slice(valueEnd + XTML_ARGUMENT_CLOSE.length);
				if (!coerced.ok) {
					callInvalidReason = `kimi-xtml: invalid value for argument "${argumentKey}".`;
					options?.onError?.(callInvalidReason, { toolCall: callName });
				} else if (argumentKey) {
					callArgs[argumentKey] = coerced.value;
					events.push({ type: "toolcall_delta", index: callIndex, argumentsDelta: JSON.stringify(callArgs) });
				}
				mode = "call-body";
				continue;
			}
			const callEnd = buffer.indexOf(XTML_CALL_CLOSE);
			if (callEnd === -1) {
				hold(events, [XTML_CALL_CLOSE], false);
				return;
			}
			buffer = buffer.slice(callEnd + XTML_CALL_CLOSE.length);
			resetCall();
			mode = "tools";
		}
	}

	return {
		feed(textDelta: string): StreamParserEvent[] {
			buffer += textDelta;
			const events: StreamParserEvent[] = [];
			process(events);
			return events;
		},
		finish(): StreamParserEvent[] {
			const events: StreamParserEvent[] = [];
			if (mode === "text") {
				if (buffer) events.push({ type: "text", text: buffer });
				buffer = "";
				return events;
			}
			if (callStarted) endCall(events, true);
			buffer = "";
			mode = "text";
			return events;
		},
	};
}
