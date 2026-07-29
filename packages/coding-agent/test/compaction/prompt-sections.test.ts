import { describe, expect, it } from "vitest";
import {
	buildPrompt,
	MERGED_COMPACTION_PROMPT_BRANCH,
	MERGED_COMPACTION_PROMPT_SYSTEM,
	MERGED_COMPACTION_PROMPT_TURN_PREFIX,
	MERGED_COMPACTION_PROMPT_UPDATE,
	MERGED_COMPACTION_PROMPT_USER,
	resolvePromptFamily,
} from "../../src/core/extensions/builtin/compaction/prompts.ts";

// ============================================================================
// Per-section presence
// ============================================================================

describe("DEFAULT variant — per-section landmarks", () => {
	it("contains the system directive header", () => {
		expect(MERGED_COMPACTION_PROMPT_SYSTEM).toContain("[SYSTEM DIRECTIVE: OH-MY-OPENCODE - COMPACTION CONTEXT]");
	});

	it("contains section 1: User Requests", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("## 1. User Requests (Verbatim)");
	});

	it("contains section 2: Final Goal", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("## 2. Final Goal");
	});

	it("contains section 3: Constraints & Preferences", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("## 3. Constraints & Preferences (Verbatim Only)");
	});

	it("contains section 4: Work Completed", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("## 4. Work Completed");
	});

	it("contains section 5: Active Working Context", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("## 5. Active Working Context");
	});

	it("contains section 6: Remaining Tasks", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("## 6. Remaining Tasks");
	});

	it("contains section 7: Exact Next Steps", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("## 7. Exact Next Steps");
	});

	it("contains the 'Quote constraints verbatim' instruction", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("Quote constraints verbatim");
	});

	it("contains the 'Do NOT invent' instruction", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("Do NOT invent");
	});
});

// ============================================================================
// Cardinal rules R1-R4 (4 tests, one each)
// ============================================================================

describe("SYSTEM block — cardinal rules", () => {
	it("R1: quotes user requests and constraints verbatim", () => {
		expect(MERGED_COMPACTION_PROMPT_SYSTEM).toContain(
			"R1. Quote user requests and constraints VERBATIM. Do not paraphrase.",
		);
	});

	it('R2: writes "None." for empty sections, never deletes a section', () => {
		expect(MERGED_COMPACTION_PROMPT_SYSTEM).toContain(
			'R2. If a section has no content, write "None." Never delete a section.',
		);
	});

	it("R3: treats previous summary fields as immutable", () => {
		expect(MERGED_COMPACTION_PROMPT_SYSTEM).toContain(
			"R3. Where a previous summary is supplied, treat its User Requests, Final Goal, and Constraints fields as IMMUTABLE. Append, never rewrite, those three sections.",
		);
	});

	it("R4: preserves every session_id, file path, and identifier byte-for-byte", () => {
		expect(MERGED_COMPACTION_PROMPT_SYSTEM).toContain(
			"R4. Preserve every session_id, file path, and identifier byte-for-byte.",
		);
	});
});

// ============================================================================
// Canonical order (1 test)
// ============================================================================

describe("DEFAULT variant — canonical section order", () => {
	it("has sections 1-7 in strict sequential order", () => {
		const s1 = MERGED_COMPACTION_PROMPT_USER.indexOf("## 1. User Requests (Verbatim)");
		const s2 = MERGED_COMPACTION_PROMPT_USER.indexOf("## 2. Final Goal");
		const s3 = MERGED_COMPACTION_PROMPT_USER.indexOf("## 3. Constraints & Preferences (Verbatim Only)");
		const s4 = MERGED_COMPACTION_PROMPT_USER.indexOf("## 4. Work Completed");
		const s5 = MERGED_COMPACTION_PROMPT_USER.indexOf("## 5. Active Working Context");
		const s6 = MERGED_COMPACTION_PROMPT_USER.indexOf("## 6. Remaining Tasks");
		const s7 = MERGED_COMPACTION_PROMPT_USER.indexOf("## 7. Exact Next Steps");

		expect(s1).toBeGreaterThanOrEqual(0);
		expect(s2).toBeGreaterThan(s1);
		expect(s3).toBeGreaterThan(s2);
		expect(s4).toBeGreaterThan(s3);
		expect(s5).toBeGreaterThan(s4);
		expect(s6).toBeGreaterThan(s5);
		expect(s7).toBeGreaterThan(s6);
	});
});

// ============================================================================
// Two-pass (2 tests)
// ============================================================================

describe("DEFAULT variant — task-intent acquisition", () => {
	it("instructs emission of the task-intent block before summary", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("<task-intent>");
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("ORIGINAL_REQUEST:");
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("TASK_TYPE:");
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("MUST_PRESERVE:");
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("MUST_NOT_LOSE:");
		expect(MERGED_COMPACTION_PROMPT_USER.indexOf("<task-intent>")).toBeLessThan(MERGED_COMPACTION_PROMPT_USER.indexOf("<summary>"));
	});

	it("lists both task-intent and summary blocks in the final IMPORTANT line", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("IMPORTANT: Respond with ONLY the <task-intent>...</task-intent> and <summary>...</summary> blocks as your text output.");
	});
});

describe("DEFAULT variant — family landmarks", () => {
	it("contains the claude baseline acquisition wording", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("structured handoff summary");
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("<task-intent>");
	});

	it("contains the gpt terse acquisition wording", () => {
		const prompt = buildPrompt({ variant: "default", promptFamily: "gpt" });
		expect(prompt.user).toContain("Write one <task-intent> block with ORIGINAL_REQUEST, TASK_TYPE, MUST_PRESERVE, and MUST_NOT_LOSE before <summary>.");
		expect(prompt.user).not.toContain("Emit <task-intent>");
	});
});

// ============================================================================
// XML wrapping (2 tests)
// ============================================================================

describe("DEFAULT variant — XML wrapping", () => {
	it("contains both opening and closing summary tags", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("<summary>");
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("</summary>");
	});

	it("has the acquisition block before summary", () => {
		expect(MERGED_COMPACTION_PROMPT_USER.indexOf("<task-intent>")).toBeLessThan(MERGED_COMPACTION_PROMPT_USER.indexOf("<summary>"));
	});
});

// ============================================================================
// Variants (3 tests)
// ============================================================================

describe("TURN_PREFIX variant", () => {
	it("does not acquire task-intent when one is already present", () => {
		const prompt = buildPrompt({ variant: "turn_prefix", taskIntent: "anchored" });
		expect(prompt.user).not.toContain("ORIGINAL_REQUEST:");
		expect(prompt.user).toContain("## 1. User Requests (Verbatim)");
	});

	it("acquires task-intent only when absent", () => {
		const prompt = buildPrompt({ variant: "turn_prefix" });
		expect(prompt.user).toContain("Silently determine the current task intent and the minimum context needed for the next turn.");
		expect(prompt.user).toContain("<summary>");
	});
});

describe("UPDATE variant", () => {
	it("injects the task-intent block before previous summary when present", () => {
		const prompt = buildPrompt({ variant: "update", previousSummary: "prev", taskIntent: "intent bytes" });
		expect(prompt.user).toContain("Immutable provenance of the original task. Do not rewrite it. Newer explicit user steering overrides it.");
		expect(prompt.user).toContain("<task-intent>");
		expect(prompt.user).toContain("intent bytes");
		expect(prompt.user.indexOf("<previous-summary>")).toBeLessThan(prompt.user.indexOf("<task-intent>"));
	});

	it("requests task-intent acquisition when absent", () => {
		const prompt = buildPrompt({ variant: "update", previousSummary: "prev" });
		expect(prompt.user).toContain("ORIGINAL_REQUEST:");
		expect(prompt.user).toContain("<previous-summary>");
	});
});


describe("BRANCH variant", () => {
	it("is unchanged", () => {
		expect(MERGED_COMPACTION_PROMPT_BRANCH).toContain("PASS 1 — Internal task-intent extraction");
		expect(MERGED_COMPACTION_PROMPT_BRANCH).toContain("PASS 2 — Emit summary biased toward Pass 1");
	});
});

describe("PROMPT FAMILY classifier", () => {
	it.each([
		[{ id: "gpt-5.6-sol", provider: "anthropic" }, "gpt"],
		[{ id: "o3", provider: "anthropic" }, "gpt"],
		[{ id: "codex", provider: "anthropic" }, "gpt"],
		[{ id: "x", provider: "azure-openai" }, "gpt"],
		[{ id: "claude", provider: "anthropic" }, "claude"],
		[{ id: "kimi", provider: "moonshot" }, "claude"],
		[{ id: "glm", provider: "zhipu" }, "claude"],
		[{ id: "unknown", provider: "unknown" }, "claude"],
	])("classifies %o as %s", (model, family) => {
		expect(resolvePromptFamily(model as never)).toBe(family);
	});
});

// ============================================================================
// Negative (1 test)
// ============================================================================

describe("DEFAULT variant — negative assertions", () => {
	it("does NOT contain '## Critical Context'", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).not.toContain("## Critical Context");
	});
});

// ============================================================================
// buildPrompt smoke test
// ============================================================================

describe("buildPrompt", () => {
	it("returns an object with system and user strings", () => {
		const result = buildPrompt({ variant: "default" });
		expect(result).toHaveProperty("system");
		expect(result).toHaveProperty("user");
		expect(typeof result.system).toBe("string");
		expect(typeof result.user).toBe("string");
	});
});
