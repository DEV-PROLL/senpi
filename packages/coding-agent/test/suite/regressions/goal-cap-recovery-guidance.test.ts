import { describe, expect, it } from "vitest";
import {
	continuationCapRecoveryHint,
	isMechanicalContinuationBlock,
	PROVIDER_ERROR_BLOCKED_REASON,
} from "../../../src/core/extensions/builtin/goal/continuation-recovery.ts";

// The cap stays as a runaway backstop; tripping it must not strand the user.
describe("goal continuation cap recovery guidance", () => {
	it("classifies every mechanical continuation guard as prompt-recoverable", () => {
		expect(isMechanicalContinuationBlock("continuation cap reached")).toBe(true);
		expect(isMechanicalContinuationBlock("repeated assistant output")).toBe(true);
		expect(isMechanicalContinuationBlock("output truncation repeated")).toBe(true);
	});

	// A terminal provider error is infrastructure, not a decision: the next user
	// message is exactly the retry signal, so the goal must resume instead of
	// stranding the run behind a block only /goal resume could clear.
	it("classifies a terminal provider error as prompt-recoverable", () => {
		expect(PROVIDER_ERROR_BLOCKED_REASON).toBe("provider error ended the turn (retries exhausted)");
		expect(isMechanicalContinuationBlock(PROVIDER_ERROR_BLOCKED_REASON)).toBe(true);
		expect(continuationCapRecoveryHint(PROVIDER_ERROR_BLOCKED_REASON)).toMatch(/send any message to resume/i);
	});

	it("does not classify intentional blocks as mechanical", () => {
		expect(isMechanicalContinuationBlock("user interrupted the turn")).toBe(false);
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
