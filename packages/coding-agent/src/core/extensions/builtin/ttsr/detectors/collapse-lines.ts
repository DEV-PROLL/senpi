import { CharCode, FixedRing, isAsciiWhitespace, type ScalarEntry } from "../stream-utils.ts";
import type { DetectorMatch } from "../types.ts";
import { isDecorativeScalar } from "./collapse-scalars.ts";

export const LINE_RING_CAPACITY = 16;
export const LINE_PERIOD_MAX = 4;
export const LINE_CYCLE_MIN_CYCLES = 6;
export const LINE_MIN_REPEATED_CHARS = 384;
export const LINE_TEXT_RETENTION_MAX = 512;

const SAMPLE_LENGTH = 80;
const HASH_A_OFFSET = 0x811c9dc5;
const HASH_A_PRIME = 0x01000193;
const HASH_B_OFFSET = 5381;
const HASH_B_MULTIPLIER = 31;

interface LineEntry {
	readonly hashA: number;
	readonly hashB: number;
	readonly utf16Length: number;
	readonly startOffset: number;
	readonly eligible: boolean;
	readonly text: string | undefined;
}

export interface LineCycleState {
	readonly ring: FixedRing<LineEntry>;
	readonly matched: number[];
	readonly repeatedChars: number[];
	readonly blockStart: number[];
	readonly cycleWidth: number[];
	hashA: number;
	hashB: number;
	length: number;
	startOffset: number;
	hasContent: boolean;
	retained: string;
	retaining: boolean;
}

export function createLineCycleState(): LineCycleState {
	return {
		ring: new FixedRing<LineEntry>(LINE_RING_CAPACITY),
		matched: new Array<number>(LINE_PERIOD_MAX + 1).fill(0),
		repeatedChars: new Array<number>(LINE_PERIOD_MAX + 1).fill(0),
		blockStart: new Array<number>(LINE_PERIOD_MAX + 1).fill(0),
		cycleWidth: new Array<number>(LINE_PERIOD_MAX + 1).fill(0),
		hashA: HASH_A_OFFSET,
		hashB: HASH_B_OFFSET,
		length: 0,
		startOffset: 0,
		hasContent: false,
		retained: "",
		retaining: true,
	};
}

function measureCycleWidth(ring: FixedRing<LineEntry>, period: number): number {
	let width = 0;
	for (let back = 1; back <= period; back++) {
		const line = ring.getBack(back);
		if (line === undefined) break;
		width += line.utf16Length + 1;
	}
	return width;
}

function measureBlockChars(ring: FixedRing<LineEntry>, period: number): number {
	let chars = 0;
	for (let back = 0; back <= period; back++) {
		const line = ring.getBack(back);
		if (line === undefined) break;
		chars += line.utf16Length;
	}
	return chars;
}

export function updateLineCycles(state: LineCycleState, entry: ScalarEntry): DetectorMatch | null {
	if (entry.value.charCodeAt(0) === CharCode.LineFeed) {
		return completeLine(state, entry);
	}
	for (let i = 0; i < entry.value.length; i++) {
		const code = entry.value.charCodeAt(i);
		state.hashA = Math.imul(state.hashA ^ code, HASH_A_PRIME);
		state.hashB = (Math.imul(state.hashB, HASH_B_MULTIPLIER) + code) | 0;
	}
	const codePoint = entry.value.codePointAt(0) ?? 0;
	if (!state.hasContent && !isAsciiWhitespace(codePoint) && !isDecorativeScalar(codePoint)) state.hasContent = true;
	state.length += entry.width;
	if (state.retaining) {
		state.retained += entry.value;
		if (state.retained.length > LINE_TEXT_RETENTION_MAX) {
			state.retaining = false;
			state.retained = "";
		}
	}
	return null;
}

function completeLine(state: LineCycleState, entry: ScalarEntry): DetectorMatch | null {
	const line: LineEntry = {
		hashA: state.hashA,
		hashB: state.hashB,
		utf16Length: state.length,
		startOffset: state.startOffset,
		eligible: state.hasContent,
		text: state.retaining ? state.retained : undefined,
	};
	state.ring.push(line);
	state.hashA = HASH_A_OFFSET;
	state.hashB = HASH_B_OFFSET;
	state.length = 0;
	state.startOffset = entry.startOffset + 1;
	state.hasContent = false;
	state.retained = "";
	state.retaining = true;
	for (let period = 1; period <= LINE_PERIOD_MAX; period++) {
		const back = state.ring.getBack(period);
		if (
			back === undefined ||
			!back.eligible ||
			!line.eligible ||
			back.utf16Length !== line.utf16Length ||
			back.hashA !== line.hashA ||
			back.hashB !== line.hashB
		) {
			state.matched[period] = 0;
			state.repeatedChars[period] = 0;
			continue;
		}
		if (state.matched[period] === 0) {
			state.blockStart[period] = back.startOffset;
			state.cycleWidth[period] = measureCycleWidth(state.ring, period);
			state.repeatedChars[period] = measureBlockChars(state.ring, period);
			state.matched[period] = 1;
		} else {
			state.matched[period] += 1;
			state.repeatedChars[period] += line.utf16Length;
		}
		if (
			state.matched[period] < (LINE_CYCLE_MIN_CYCLES - 1) * period ||
			state.repeatedChars[period] < LINE_MIN_REPEATED_CHARS
		) {
			continue;
		}
		const cycles = Math.floor(state.matched[period] / period) + 1;
		return {
			rule: "collapse-repetition",
			reason: `line cycle with period ${period} over ${cycles} cycles (${state.repeatedChars[period]} repeated chars)`,
			anomalyStartOffset: state.blockStart[period],
			garbageStartOffset: state.blockStart[period] + state.cycleWidth[period],
			detail: {
				mechanism: "line-cycle",
				period,
				cycles,
				repeatedChars: state.repeatedChars[period],
				sample: (line.text ?? "").slice(0, SAMPLE_LENGTH),
			},
		};
	}
	return null;
}
