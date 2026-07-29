import { describe, expect, it } from "vitest";
import { EVAL_CELLS_STATUS_KEY, formatEvalCellStatus } from "../src/extension/eval-status.ts";
import type { EvalDetachedCellStatusEntry } from "../src/tool/detached-cell-manager.ts";

function entry(cellId: string, language: "js" | "py", title?: string): EvalDetachedCellStatusEntry {
	return title === undefined ? { cellId, language } : { cellId, language, title };
}

describe("formatEvalCellStatus", () => {
	it("exports the footer status key used for detached eval cells", () => {
		expect(EVAL_CELLS_STATUS_KEY).toBe("eval-cells");
	});

	it("returns undefined when no cells are detached, clearing the footer status", () => {
		expect(formatEvalCellStatus([])).toBeUndefined();
	});

	it("shows glyph, language, and title for a single detached cell", () => {
		expect(formatEvalCellStatus([entry("cell-1", "py", "numpy feather rerun")])).toBe("↗ py · numpy feather rerun");
	});

	it("falls back to the cell id when the cell has no title", () => {
		expect(formatEvalCellStatus([entry("cell-123", "js")])).toBe("↗ js · cell-123");
	});

	it("truncates an overlong single title to the shared 48-char budget with an ellipsis", () => {
		const longTitle = "x".repeat(80);
		const status = formatEvalCellStatus([entry("cell-1", "py", longTitle)]);
		expect(status).toBe(`↗ py · ${"x".repeat(48 - "↗ py · ".length - 1)}…`);
		expect(status?.length).toBe(48);
	});

	it("lists every title when multiple detached cells fit the budget", () => {
		expect(formatEvalCellStatus([entry("a", "js", "alpha"), entry("b", "py", "beta")])).toBe("↗ eval 2: alpha, beta");
	});

	it("keeps only whole titles and folds the rest into a +N more tail", () => {
		const entries = [
			entry("a", "js", "first-cell-title"),
			entry("b", "py", "second-cell-title"),
			entry("c", "js", "third-cell-title"),
		];
		const status = formatEvalCellStatus(entries);
		expect(status).toBe("↗ eval 3: first-cell-title +2 more");
		expect(status?.length).toBeLessThanOrEqual(48);
	});

	it("keeps the +N more counter when not even one whole title fits", () => {
		const entries = [
			entry("a", "js", "a-very-long-cell-title-that-cannot-fit"),
			entry("b", "py", "another-long-cell-title-that-cannot-fit"),
		];
		const status = formatEvalCellStatus(entries);
		expect(status).toMatch(/^↗ eval 2: a-very-long-cell-title-tha\S*… \+1 more$/u);
		expect(status?.length).toBeLessThanOrEqual(48);
	});
});
