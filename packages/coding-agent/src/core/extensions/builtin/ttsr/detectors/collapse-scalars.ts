import { CharCode, isAsciiWhitespace, type ScalarEntry } from "../stream-utils.ts";
import type { DetectorMatch } from "../types.ts";

export const CJK_SCALAR_RUN_THRESHOLD = 224;
export const PUNCTUATION_RUN_THRESHOLD = 256;
export const RUN_WHITESPACE_MAX_CHARS = 32;
export const RUN_WHITESPACE_TARGET_RATIO = 8;
export const NEWLINE_FLOOD_MIN_CHARS = 320;
export const NEWLINE_FLOOD_MIN_NEWLINES = 8;
export const GENERIC_FLOOD_MIN_CHARS = 480;

const ASCII_PRINTABLE_MAX = 0x7e;
const ASCII_END = 0x7f;
const BOX_DRAWING_START = 0x2500;
const BLOCK_ELEMENT_END = 0x259f;
const NON_DECORATIVE_ASCII_PUNCT: ReadonlySet<number> = new Set([33, 36, 37, 38, 63, 64]);

function codePointOf(entry: ScalarEntry): number {
	return entry.value.codePointAt(0) ?? 0;
}

export function isAsciiAlphanumeric(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

export function isBoxDrawing(code: number): boolean {
	return code >= BOX_DRAWING_START && code <= BLOCK_ELEMENT_END;
}

export function isDecorativeScalar(code: number): boolean {
	if (code <= ASCII_END) {
		return (
			code > CharCode.Space &&
			code <= ASCII_PRINTABLE_MAX &&
			!isAsciiAlphanumeric(code) &&
			!NON_DECORATIVE_ASCII_PUNCT.has(code)
		);
	}
	return isBoxDrawing(code);
}

function runThresholdFor(entry: ScalarEntry): number {
	const code = codePointOf(entry);
	if (code > ASCII_END) {
		return isBoxDrawing(code) ? 0 : CJK_SCALAR_RUN_THRESHOLD;
	}
	return NON_DECORATIVE_ASCII_PUNCT.has(code) ? PUNCTUATION_RUN_THRESHOLD : 0;
}

export interface DominantRunState {
	active: boolean;
	target: string;
	targetWidth: number;
	threshold: number;
	count: number;
	whitespaceUsed: number;
	startOffset: number;
}

export function createDominantRunState(): DominantRunState {
	return { active: false, target: "", targetWidth: 0, threshold: 0, count: 0, whitespaceUsed: 0, startOffset: 0 };
}

export function updateDominantRun(state: DominantRunState, entry: ScalarEntry): DetectorMatch | null {
	const code = codePointOf(entry);
	if (isAsciiWhitespace(code)) {
		if (!state.active) return null;
		const nextWhitespace = state.whitespaceUsed + 1;
		if (nextWhitespace > RUN_WHITESPACE_MAX_CHARS || nextWhitespace * RUN_WHITESPACE_TARGET_RATIO > state.count) {
			state.active = false;
			return null;
		}
		state.whitespaceUsed = nextWhitespace;
		return null;
	}
	const threshold = runThresholdFor(entry);
	if (threshold === 0) {
		state.active = false;
		return null;
	}
	if (!state.active || state.target !== entry.value) {
		state.active = true;
		state.target = entry.value;
		state.targetWidth = entry.width;
		state.threshold = threshold;
		state.count = 1;
		state.whitespaceUsed = 0;
		state.startOffset = entry.startOffset;
		return null;
	}
	state.count += 1;
	if (state.count < state.threshold) return null;
	return {
		rule: "collapse-repetition",
		reason: `dominant scalar run U+${code.toString(16)} repeated ${state.count} times`,
		anomalyStartOffset: state.startOffset,
		garbageStartOffset: state.startOffset + state.targetWidth,
		detail: { mechanism: "dominant-scalar-run", codePoint: code, count: state.count, threshold: state.threshold },
	};
}

export interface WhitespaceFloodState {
	count: number;
	newlines: number;
	startOffset: number;
}

export function createWhitespaceFloodState(): WhitespaceFloodState {
	return { count: 0, newlines: 0, startOffset: 0 };
}

export function updateWhitespaceFlood(state: WhitespaceFloodState, entry: ScalarEntry): DetectorMatch | null {
	const code = codePointOf(entry);
	if (!isAsciiWhitespace(code)) {
		state.count = 0;
		state.newlines = 0;
		return null;
	}
	if (state.count === 0) state.startOffset = entry.startOffset;
	state.count += 1;
	if (code === CharCode.LineFeed) state.newlines += 1;
	const newlineFlood = state.count >= NEWLINE_FLOOD_MIN_CHARS && state.newlines >= NEWLINE_FLOOD_MIN_NEWLINES;
	const genericFlood = state.count >= GENERIC_FLOOD_MIN_CHARS;
	if (!newlineFlood && !genericFlood) return null;
	return {
		rule: "collapse-repetition",
		reason: `whitespace flood of ${state.count} characters with ${state.newlines} newlines`,
		anomalyStartOffset: state.startOffset,
		garbageStartOffset: state.startOffset + 1,
		detail: { mechanism: "whitespace-flood", whitespaceChars: state.count, newlines: state.newlines },
	};
}
