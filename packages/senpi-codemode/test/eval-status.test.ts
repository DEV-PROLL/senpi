import { describe, expect, it } from "vitest";
import { EVAL_CELLS_STATUS_KEY, formatEvalCellStatus } from "../src/extension/eval-status.ts";
import type { EvalDetachedCellStatusEntry } from "../src/tool/detached-cell-manager.ts";

const T0 = 1_000_000;

function entry(
	cellId: string,
	language: "js" | "py",
	summary?: string,
	startedAtMs = T0,
): EvalDetachedCellStatusEntry {
	return summary === undefined
		? { cellId, language, startedAtMs }
		: { cellId, language, summary, startedAtMs };
}

describe("formatEvalCellStatus", () => {
	it("exports the footer status key used for detached eval cells", () => {
		expect(EVAL_CELLS_STATUS_KEY).toBe("eval-cells");
	});

	it("returns undefined when no cells are detached, clearing the footer status", () => {
		expect(formatEvalCellStatus([], T0)).toBeUndefined();
	});

	it("shows glyph, language, and summary for a single detached cell", () => {
		expect(formatEvalCellStatus([entry("cell-1", "py", "numpy feather rerun")], T0 + 5_000)).toBe(
			"↗ py · numpy feather rerun (5s)",
		);
	});

	it("falls back to the cell id when the cell has no summary", () => {
		expect(formatEvalCellStatus([entry("cell-123", "js")], T0 + 180_000)).toBe("↗ js · cell-123 (3m)");
	});

	it("falls back to the cell id when the summary is empty", () => {
		expect(formatEvalCellStatus([entry("cell-123", "js", "")], T0)).toBe("↗ js · cell-123 (0s)");
	});

	it("truncates an overlong single summary to the shared 48-char budget with an ellipsis", () => {
		const longSummary = "x".repeat(80);
		const status = formatEvalCellStatus([entry("cell-1", "py", longSummary)], T0);
		expect(status).toBe(`↗ py · ${"x".repeat(48 - "↗ py · ".length - " (0s)".length - 1)}… (0s)`);
		expect(status?.length).toBe(48);
	});

	it("truncates a Korean summary to the length budget by code units", () => {
		const koreanSummary = "src 전체에서 legacyClient 사용처 집계".repeat(3);
		const status = formatEvalCellStatus([entry("cell-ko", "py", koreanSummary)], T0);
		expect(status?.length).toBeLessThanOrEqual(48);
		expect(status).toContain("src 전체에서");
		expect(status).toMatch(/… \(0s\)$/u);
	});

	it("lists every summary when multiple detached cells fit the budget", () => {
		expect(formatEvalCellStatus([entry("a", "js", "alpha"), entry("b", "py", "beta")], T0 + 60_000)).toBe(
			"↗ eval 2: alpha, beta (1m)",
		);
	});

	it("keeps only whole summaries and folds the rest into a +N more tail", () => {
		const entries = [
			entry("a", "js", "first-cell-title"),
			entry("b", "py", "second-cell-title"),
			entry("c", "js", "third-cell-title"),
		];
		const status = formatEvalCellStatus(entries, T0);
		expect(status).toBe("↗ eval 3: first-cell-title +2 more (0s)");
		expect(status?.length).toBeLessThanOrEqual(48);
	});

	it("keeps the +N more counter when not even one whole summary fits", () => {
		const entries = [
			entry("a", "js", "a-very-long-cell-title-that-cannot-fit"),
			entry("b", "py", "another-long-cell-title-that-cannot-fit"),
		];
		const status = formatEvalCellStatus(entries, T0);
		expect(status).toMatch(/^↗ eval 2: a-very-long-cell-tit\S*… \+1 more \(0s\)$/u);
		expect(status?.length).toBeLessThanOrEqual(48);
	});

	it("advances the elapsed label as time passes over the same entries", () => {
		const entries = [entry("cell-1", "py", "long running cell")];
		expect(formatEvalCellStatus(entries, T0 + 5_000)).toBe("↗ py · long running cell (5s)");
		expect(formatEvalCellStatus(entries, T0 + 6_000)).toBe("↗ py · long running cell (6s)");
	});

	it("shows the oldest cell's elapsed time when several cells are detached", () => {
		const entries = [entry("a", "js", "alpha"), entry("b", "py", "beta", T0 + 30_000)];
		expect(formatEvalCellStatus(entries, T0 + 90_000)).toBe("↗ eval 2: alpha, beta (1m)");
	});

	it("never shows negative elapsed when the clock moves backwards", () => {
		expect(formatEvalCellStatus([entry("cell-1", "py", "clock skew")], T0 - 5_000)).toBe("↗ py · clock skew (0s)");
	});
});
