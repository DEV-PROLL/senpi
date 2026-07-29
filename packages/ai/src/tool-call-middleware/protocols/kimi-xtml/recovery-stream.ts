import type { Tool } from "../../../types.ts";
import type { ParserOptions, StreamParserEvent } from "../../types.ts";
import type { RecoveryStreamParser } from "../anthropic-xml/recovery-stream.ts";
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

const CHANNEL_MARKER_PATTERN = /^<\|(?:open|close)\|>[a-zA-Z_][a-zA-Z0-9_]*<\|sep\|>/;
const OPEN_PREFIX = "<|open|>";
const CLOSE_PREFIX = "<|close|>";

function couldBeMarkerPrefix(tail: string): boolean {
	if (OPEN_PREFIX.startsWith(tail) || CLOSE_PREFIX.startsWith(tail)) return true;
	for (const prefix of [OPEN_PREFIX, CLOSE_PREFIX]) {
		if (!tail.startsWith(prefix)) continue;
		const rest = tail.slice(prefix.length);
		const angleIndex = rest.indexOf("<");
		if (angleIndex === -1) return /^[a-zA-Z0-9_]*$/.test(rest);
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rest.slice(0, angleIndex))) return false;
		return XTML_SEP.startsWith(rest.slice(angleIndex));
	}
	return false;
}

export function createXtmlRecoveryStreamParser(tools: readonly Tool[], options?: ParserOptions): RecoveryStreamParser {
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

	function endCall(events: StreamParserEvent[], incomplete: boolean): void {
		if (!callStarted) {
			resetCall();
			return;
		}
		const event: StreamParserEvent = {
			type: "toolcall_end",
			index: callIndex,
			name: callName,
			id: `recovered-xtml-${callIndex}`,
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

	function processText(events: StreamParserEvent[]): boolean {
		const openIndex = buffer.indexOf(OPEN_PREFIX);
		const closeIndex = buffer.indexOf(CLOSE_PREFIX);
		const markerIndex = [openIndex, closeIndex].filter((index) => index !== -1).sort((a, b) => a - b)[0];
		if (markerIndex === undefined) {
			const partial = getPartialXtmlSuffix(buffer, [OPEN_PREFIX, CLOSE_PREFIX]);
			const flushable = partial ? buffer.slice(0, -partial.length) : buffer;
			if (flushable) events.push({ type: "text", text: flushable });
			buffer = partial;
			return false;
		}
		if (markerIndex > 0) {
			events.push({ type: "text", text: buffer.slice(0, markerIndex) });
			buffer = buffer.slice(markerIndex);
			return true;
		}
		const markerMatch = CHANNEL_MARKER_PATTERN.exec(buffer);
		if (markerMatch) {
			const marker = markerMatch[0];
			buffer = buffer.slice(marker.length);
			if (marker === XTML_TOOLS_OPEN) mode = "tools";
			return true;
		}
		if (couldBeMarkerPrefix(buffer)) return false;
		events.push({ type: "text", text: buffer.slice(0, 2) });
		buffer = buffer.slice(2);
		return true;
	}

	function process(events: StreamParserEvent[]): void {
		for (;;) {
			if (mode === "text") {
				if (!processText(events)) return;
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
				if (callStart === -1) return;
				buffer = buffer.slice(callStart + XTML_CALL_OPEN.length);
				mode = "call-header";
				continue;
			}
			if (mode === "call-header" || mode === "argument-header") {
				const sepIndex = buffer.indexOf(XTML_SEP);
				if (sepIndex === -1) return;
				const attributes = parseXtmlAttributes(buffer.slice(0, sepIndex));
				buffer = buffer.slice(sepIndex + XTML_SEP.length);
				if (mode === "call-header") {
					const name = attributes.tool ?? "";
					if (!tools.some((candidate) => candidate.name === name)) {
						options?.onError?.(`kimi-xtml recovery: call for unknown tool "${name}".`, {});
						mode = "discard-call";
						continue;
					}
					callIndex += 1;
					callName = name;
					callStarted = true;
					events.push({ type: "toolcall_start", index: callIndex, name, id: `recovered-xtml-${callIndex}` });
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
				if (argStart === -1) return;
				buffer = buffer.slice(argStart + XTML_ARGUMENT_OPEN.length);
				mode = "argument-header";
				continue;
			}
			if (mode === "argument-value") {
				const valueEnd = buffer.indexOf(XTML_ARGUMENT_CLOSE);
				if (valueEnd === -1) return;
				const coerced = coerceXtmlArgumentValue(buffer.slice(0, valueEnd), argumentType);
				buffer = buffer.slice(valueEnd + XTML_ARGUMENT_CLOSE.length);
				if (!coerced.ok) {
					callInvalidReason = `kimi-xtml recovery: invalid value for argument "${argumentKey}".`;
					options?.onError?.(callInvalidReason, { toolCall: callName });
				} else if (argumentKey) {
					callArgs[argumentKey] = coerced.value;
					events.push({ type: "toolcall_delta", index: callIndex, argumentsDelta: JSON.stringify(callArgs) });
				}
				mode = "call-body";
				continue;
			}
			const callEnd = buffer.indexOf(XTML_CALL_CLOSE);
			if (callEnd === -1) return;
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
		interrupt(): StreamParserEvent[] {
			const events: StreamParserEvent[] = [];
			if (mode === "text" && buffer) {
				events.push({ type: "text", text: buffer });
				buffer = "";
			}
			return events;
		},
		finish(): StreamParserEvent[] {
			const events: StreamParserEvent[] = [];
			if (mode === "text") {
				if (buffer) events.push({ type: "text", text: buffer });
			} else if (callStarted) {
				endCall(events, true);
			}
			buffer = "";
			mode = "text";
			return events;
		},
	};
}
