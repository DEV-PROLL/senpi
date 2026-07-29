import { type FixedRing, isAsciiWhitespace, type ScalarEntry } from "../stream-utils.ts";
import type { DetectorMatch } from "../types.ts";
import { isAsciiAlphanumeric, isDecorativeScalar } from "./collapse-scalars.ts";

export const PERIOD_MIN = 2;
export const PERIOD_MAX = 64;
export const PERIOD_SPAN_MIN = 256;
export const PERIOD_REPS_MIN = 8;

const SLOT_COUNT = PERIOD_MAX + 1;
const BASE64_EXTRA_CODES: ReadonlySet<number> = new Set([43, 47, 61]);
const TABULAR_SEPARATOR_CODES: ReadonlySet<number> = new Set([46, 44, 58, 59, 45, 47, 124]);
const CODE_PUNCT_CODES: ReadonlySet<number> = new Set(
	"{}()[]<>,;.:=+-*/&|^%$#@~`'\"\\_".split("").map((ch) => ch.charCodeAt(0)),
);

function everyCodeUnit(text: string, predicate: (code: number) => boolean): boolean {
	for (let i = 0; i < text.length; i++) {
		if (!predicate(text.charCodeAt(i))) return false;
	}
	return true;
}

function isDigitOrHexLetter(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function isWhitespaceOnlyUnit(unit: string): boolean {
	return everyCodeUnit(unit, isAsciiWhitespace);
}

function isDecorativeUnit(unit: string): boolean {
	return everyCodeUnit(unit, (code) => isAsciiWhitespace(code) || isDecorativeScalar(code));
}

function isBase64CompatibleUnit(unit: string): boolean {
	return everyCodeUnit(unit, (code) => isAsciiAlphanumeric(code) || BASE64_EXTRA_CODES.has(code));
}

function isNumericTabularUnit(unit: string): boolean {
	return everyCodeUnit(
		unit,
		(code) => isAsciiWhitespace(code) || TABULAR_SEPARATOR_CODES.has(code) || isDigitOrHexLetter(code),
	);
}

function isCodeLikeUnit(unit: string): boolean {
	return everyCodeUnit(unit, (code) => isAsciiWhitespace(code) || CODE_PUNCT_CODES.has(code));
}

function isEligibleUnit(unit: string): boolean {
	return (
		!isWhitespaceOnlyUnit(unit) &&
		!isDecorativeUnit(unit) &&
		!isBase64CompatibleUnit(unit) &&
		!isNumericTabularUnit(unit) &&
		!isCodeLikeUnit(unit)
	);
}

export interface ShortPeriodState {
	readonly matched: number[];
	readonly blockStart: number[];
	readonly unitChecked: boolean[];
}

export function createShortPeriodState(): ShortPeriodState {
	return {
		matched: new Array<number>(SLOT_COUNT).fill(0),
		blockStart: new Array<number>(SLOT_COUNT).fill(0),
		unitChecked: new Array<boolean>(SLOT_COUNT).fill(false),
	};
}

function readUnit(ring: FixedRing<ScalarEntry>, period: number): { text: string; width: number } {
	let text = "";
	let width = 0;
	for (let back = period - 1; back >= 0; back--) {
		const scalar = ring.getBack(back);
		if (scalar === undefined) break;
		text = scalar.value + text;
		width += scalar.width;
	}
	return { text, width };
}

export function updateShortPeriods(
	state: ShortPeriodState,
	entry: ScalarEntry,
	ring: FixedRing<ScalarEntry>,
): DetectorMatch | null {
	for (let period = PERIOD_MIN; period <= PERIOD_MAX; period++) {
		const back = ring.getBack(period);
		if (back === undefined || back.value !== entry.value) {
			state.matched[period] = 0;
			state.unitChecked[period] = false;
			continue;
		}
		if (state.matched[period] === 0) state.blockStart[period] = back.startOffset;
		state.matched[period] += 1;
		if (state.unitChecked[period]) continue;
		if (state.matched[period] < PERIOD_SPAN_MIN || state.matched[period] < PERIOD_REPS_MIN * period) continue;
		state.unitChecked[period] = true;
		const unit = readUnit(ring, period);
		if (!isEligibleUnit(unit.text)) continue;
		const matched = state.matched[period];
		return {
			rule: "collapse-repetition",
			reason: `short-period recurrence with period ${period} spanning ${matched} scalars`,
			anomalyStartOffset: state.blockStart[period],
			garbageStartOffset: state.blockStart[period] + unit.width,
			detail: { mechanism: "short-period", period, span: matched, repetitions: Math.floor(matched / period) + 1 },
		};
	}
	return null;
}
