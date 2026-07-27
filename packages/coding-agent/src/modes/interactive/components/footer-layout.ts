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
	/** Always-kept leading segments (pwd first, then branch). */
	readonly anchor: readonly [FooterSegment, ...FooterSegment[]];
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
	| { readonly kind: "middle-elided"; readonly keptMiddleCount: number; readonly showMarker: boolean }
	| { readonly kind: "pwd-elided"; readonly pwdPlain: string }
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
 * the right edge and the anchor/tail segments stay visible; the middle stats
 * yield first (right-most first), then the pwd shrinks from its head.
 */
export function planFooterLayout(input: FooterLayoutInput): FooterLayout {
	const { anchor, middle, tail, right } = input;
	const fullLeft = [...anchor, ...middle, tail];
	if (right.full !== undefined && fits(fullLeft, right.full, input)) {
		return { kind: "full", useFullRight: true };
	}
	if (fits(fullLeft, right.minimal, input)) {
		return { kind: "full", useFullRight: false };
	}
	for (let kept = middle.length - 1; kept >= 0; kept--) {
		const candidate = [...anchor, ...middle.slice(0, kept), input.ellipsisMarker, tail];
		if (fits(candidate, right.minimal, input)) {
			return { kind: "middle-elided", keptMiddleCount: kept, showMarker: true };
		}
	}
	if (fits([...anchor, tail], right.minimal, input)) {
		return { kind: "middle-elided", keptMiddleCount: 0, showMarker: false };
	}
	const [, ...anchorRest] = anchor;
	const restWidth = segmentsWidth([...anchorRest, tail], input.separator) + visibleWidth(input.separator);
	const pwdBudget = input.width - input.minPadding - visibleWidth(right.minimal.plain) - restWidth;
	if (pwdBudget >= 2) {
		return { kind: "pwd-elided", pwdPlain: elideHead(anchor[0].plain, pwdBudget) };
	}
	const leftBudget = input.width - input.minPadding - visibleWidth(right.minimal.plain);
	if (leftBudget >= 1) {
		const allLeftPlain = [...anchor, tail].map((segment) => segment.plain).join(input.separator);
		return { kind: "left-elided", leftPlain: elideHead(allLeftPlain, leftBudget) };
	}
	return { kind: "right-truncated", rightPlain: truncateToWidth(right.minimal.plain, input.width, "") };
}
