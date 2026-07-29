import { LEAK_ERROR_MESSAGE, renderSystemInterrupt } from "./prompts.ts";
import { TTSR_INJECTION_CUSTOM_TYPE } from "./types.ts";

const TRUNCATION_MARKER = "[output interrupted by stream rule]";
const TRANSPORT_TIMEOUT_ERROR_PATTERN = /^Request timed out\.?$/i;

export interface TruncatableAssistantMessage {
	readonly role: "assistant";
	readonly content: unknown[];
	readonly stopReason: string;
	readonly errorMessage?: string;
	readonly [key: string]: unknown;
}

export interface ErrorShellReplacement {
	readonly role: "assistant";
	readonly content: never[];
	readonly stopReason: "error";
	readonly errorMessage: string;
}

export interface TtsrNudgeMessage {
	readonly customType: typeof TTSR_INJECTION_CUSTOM_TYPE;
	readonly content: string;
	readonly display: false;
	readonly details: { readonly rules: readonly string[] };
}

type StreamKind = "text" | "thinking";

interface MutableTruncateResult {
	role: "assistant";
	content: unknown[];
	stopReason: string;
	errorMessage?: string;
	[key: string]: unknown;
}

function streamBlockText(block: unknown, kind: StreamKind): string | undefined {
	if (typeof block !== "object" || block === null) return undefined;
	if (!("type" in block) || block.type !== kind) return undefined;
	const value: unknown = Reflect.get(block, kind);
	return typeof value === "string" ? value : undefined;
}

function replaceStreamBlockText(block: unknown, kind: StreamKind, text: string): unknown {
	if (typeof block !== "object" || block === null) return block;
	return { ...block, [kind]: text };
}

export function buildTruncateReplacement(
	message: TruncatableAssistantMessage,
	garbageStartOffset: number,
	streamKind: StreamKind,
): TruncatableAssistantMessage {
	let remaining = Math.max(0, garbageStartOffset);
	let truncated = false;
	const content: unknown[] = [];
	for (const block of message.content) {
		const text = streamBlockText(block, streamKind);
		if (truncated && text !== undefined) continue;
		if (text === undefined || remaining > text.length) {
			content.push(block);
			if (text !== undefined) remaining -= text.length;
			continue;
		}
		content.push(replaceStreamBlockText(block, streamKind, text.slice(0, remaining)));
		truncated = true;
	}
	content.push({ type: "text", text: TRUNCATION_MARKER });
	const result: MutableTruncateResult = { ...message, content };
	if (result.errorMessage !== undefined && TRANSPORT_TIMEOUT_ERROR_PATTERN.test(result.errorMessage)) {
		delete result.errorMessage;
	}
	return result;
}

export function buildErrorShellReplacement(): ErrorShellReplacement {
	return { role: "assistant", content: [], stopReason: "error", errorMessage: LEAK_ERROR_MESSAGE };
}

export function buildNudgeMessage(ruleName: string, ruleContent: string): TtsrNudgeMessage {
	return {
		customType: TTSR_INJECTION_CUSTOM_TYPE,
		content: renderSystemInterrupt(ruleName, ruleContent),
		display: false,
		details: { rules: [ruleName] },
	};
}
