import { describe, expect, it } from "vitest";
import {
	continuationCapRecoveryHint,
	isMechanicalContinuationBlock,
} from "../../../src/core/extensions/builtin/goal/continuation-recovery.ts";

// The cap stays as a runaway backstop; tripping it must not strand the user.
describe("goal continuation cap recovery guidance", () => {
	it("classifies every mechanical continuation guard as prompt-recoverable", () => {
		expect(isMechanicalContinuationBlock("continuation cap reached")).toBe(true);
		expect(isMechanicalContinuationBlock("repeated assistant output")).toBe(true);
		expect(isMechanicalContinuationBlock("output truncation repeated")).toBe(true);
	});

	it("does not classify intentional blocks as mechanical", () => {
		expect(isMechanicalContinuationBlock("user interrupted the turn")).toBe(false);
		expect(isMechanicalContinuationBlock("provider error ended the turn (retries exhausted)")).toBe(false);
		expect(isMechanicalContinuationBlock("Waiting on a user decision")).toBe(false);
		expect(isMechanicalContinuationBlock(undefined)).toBe(false);
	});

	it("tells the user how to recover from a mechanical block instead of only naming it", () => {
		const hint = continuationCapRecoveryHint("continuation cap reached");
		expect(hint).toContain("continuation cap reached");
		expect(hint).toMatch(/send any message to resume/i);
	});

	it("omits resume guidance for blocks a message does not clear", () => {
		expect(continuationCapRecoveryHint("user interrupted the turn")).not.toMatch(/send any message to resume/i);
	});
});
