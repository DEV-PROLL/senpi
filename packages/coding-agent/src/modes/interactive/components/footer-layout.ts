import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * A single footer segment: plain text drives the width math, colored text is
 * what actually renders. Kept as a pair so truncation decisions never have to
 * strip ANSI codes.
 */
export interface FooterSegment {
	readonly plain: string;
	readonly colored: string;
}

export interface FooterRightLabel {
	/** Model label only (e.g. "gpt-5.6:high"); the form that must always fit. */
	readonly minimal: FooterSegment;
	/** Model label with provider prefix; used only when the full layout fits. */
	readonly full: FooterSegment | undefined;
}

export interface FooterLayoutInput {
	readonly width: number;
	/** Always-kept leading segments in display order. */
	readonly anchor: readonly [FooterSegment, ...FooterSegment[]];
	/** Index of the pwd segment inside anchor. */
	readonly pwdIndex: number;
	/** Droppable middle segments in display order; dropped from the right end first. */
	readonly middle: readonly FooterSegment[];
	/** Always-kept trailing segment (context usage). */
	readonly tail: FooterSegment;
	readonly right: FooterRightLabel;
	/** Plain separator placed between left segments. */
	readonly separator: string;
	/** Minimum gap between the left block and the right label. */
	readonly minPadding: number;
	/** Marker shown where middle segments were elided. */
	readonly ellipsisMarker: FooterSegment;
}

/**
 * How the footer fits the terminal width, from "everything visible" down to
 * "only the model label survives". The caller materializes the plan into text.
 */
export type FooterLayout =
	| { readonly kind: "full"; readonly useFullRight: boolean }
	| {
			readonly kind: "middle-elided";
			readonly keptMiddleCount: number;
			readonly showMarker: boolean;
			readonly useFullRight: boolean;
	  }
	| {
			readonly kind: "pwd-elided";
			readonly pwdPlain: string;
			readonly keptMiddleCount: number;
			readonly showMarker: boolean;
			readonly useFullRight: boolean;
	  }
	| { readonly kind: "left-elided"; readonly leftPlain: string }
	| { readonly kind: "right-truncated"; readonly rightPlain: string };

function segmentsWidth(segments: readonly FooterSegment[], separator: string): number {
	if (segments.length === 0) return 0;
	let total = visibleWidth(separator) * (segments.length - 1);
	for (const segment of segments) total += visibleWidth(segment.plain);
	return total;
}

function fits(left: readonly FooterSegment[], right: FooterSegment, input: FooterLayoutInput): boolean {
	return segmentsWidth(left, input.separator) + input.minPadding + visibleWidth(right.plain) <= input.width;
}

function pwdBudget(rest: readonly FooterSegment[], right: FooterSegment, input: FooterLayoutInput): number {
	return (
		input.width -
		input.minPadding -
		visibleWidth(right.plain) -
		visibleWidth(input.separator) -
		segmentsWidth(rest, input.separator)
	);
}

/**
 * Elide the head of a string so it fits maxWidth, keeping the tail (the most
 * identifying part of a path) and marking the cut with a single "…".
 */
export function elideHead(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	if (maxWidth === 1) return "…";
	const budget = maxWidth - visibleWidth("…");
	const chars = [...text];
	const kept: string[] = [];
	let used = 0;
	for (let i = chars.length - 1; i >= 0; i--) {
		const char = chars[i];
		if (char === undefined) break;
		const charWidth = visibleWidth(char);
		if (used + charWidth > budget) break;
		kept.unshift(char);
		used += charWidth;
	}
	return `…${kept.join("")}`;
}

/**
 * Pick the richest layout that fits the width. The model label is pinned to
 * the right edge and the anchor/tail segments stay visible. The pwd shrinks
 * from its head before middle stats yield from the right.
 */
export function planFooterLayout(input: FooterLayoutInput): FooterLayout {
	const { anchor, middle, tail, right } = input;
	const pwd = anchor[input.pwdIndex];
	if (pwd === undefined) throw new RangeError(`pwdIndex ${input.pwdIndex} is outside the footer anchor`);
	const anchorRest = anchor.filter((_, index) => index !== input.pwdIndex);
	const preferPwdElision = visibleWidth(pwd.plain) > Math.floor(input.width / 3);

	const planForRight = (rightSegment: FooterSegment, useFullRight: boolean): FooterLayout | undefined => {
		const candidates = [
			{ keptMiddleCount: middle.length, showMarker: false },
			...Array.from({ length: middle.length }, (_, index) => ({
				keptMiddleCount: middle.length - index - 1,
				showMarker: true,
			})),
			{ keptMiddleCount: 0, showMarker: false },
		];

		for (const candidate of candidates) {
			const retainedMiddle = middle.slice(0, candidate.keptMiddleCount);
			const marker = candidate.showMarker ? [input.ellipsisMarker] : [];
			const left = [...anchor, ...retainedMiddle, ...marker, tail];
			if (fits(left, rightSegment, input)) {
				if (candidate.keptMiddleCount === middle.length) {
					return { kind: "full", useFullRight };
				}
				return { kind: "middle-elided", ...candidate, useFullRight };
			}

			const isMinimalFallback = !useFullRight && candidate.keptMiddleCount === 0 && !candidate.showMarker;
			if (preferPwdElision || isMinimalFallback) {
				const budget = pwdBudget([...anchorRest, ...retainedMiddle, ...marker, tail], rightSegment, input);
				if (budget >= 2) {
					return {
						kind: "pwd-elided",
						pwdPlain: elideHead(pwd.plain, budget),
						...candidate,
						useFullRight,
					};
				}
			}
		}

		return undefined;
	};

	if (right.full !== undefined) {
		const fullRightPlan = planForRight(right.full, true);
		if (fullRightPlan !== undefined) return fullRightPlan;
	}

	const minimalRightPlan = planForRight(right.minimal, false);
	if (minimalRightPlan !== undefined) return minimalRightPlan;

	const leftBudget = input.width - input.minPadding - visibleWidth(right.minimal.plain);
	if (leftBudget >= 1) {
		const allLeftPlain = [...anchor, tail].map((segment) => segment.plain).join(input.separator);
		return { kind: "left-elided", leftPlain: elideHead(allLeftPlain, leftBudget) };
	}
	return { kind: "right-truncated", rightPlain: truncateToWidth(right.minimal.plain, input.width, "") };
}
