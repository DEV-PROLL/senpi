import { describe, expect, it } from "vitest";
import { evaluateAbortOutcome } from "../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";

describe("claude-sdk-oauth abort continuity", () => {
	it("keeps the live session when the interrupt receipt proves nothing is still queued", () => {
		expect(evaluateAbortOutcome({ still_queued: [] })).toBe("keep");
	});

	it("reattaches instead of continuing when queued work survived the interrupt", () => {
		expect(evaluateAbortOutcome({ still_queued: ["uuid-1"] })).toBe("reattach");
	});

	it("reattaches when the CLI returns a legacy receipt with no queue information", () => {
		expect(evaluateAbortOutcome(undefined)).toBe("reattach");
		expect(evaluateAbortOutcome({})).toBe("reattach");
	});

	it("never resolves an abort to a flattened re-send", () => {
		const outcomes = [
			evaluateAbortOutcome({ still_queued: [] }),
			evaluateAbortOutcome({ still_queued: ["a"] }),
			evaluateAbortOutcome(undefined),
			evaluateAbortOutcome("garbage"),
		];

		expect(outcomes.every((outcome) => outcome === "keep" || outcome === "reattach")).toBe(true);
	});
});
