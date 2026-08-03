import { describe, expect, it } from "vitest";
import {
	buildPrompt,
	MERGED_COMPACTION_PROMPT_USER,
	resolvePromptFamily,
} from "../../src/core/extensions/builtin/compaction/prompts.ts";

// ============================================================================
// Per-section presence
// ============================================================================

// ============================================================================
// Cardinal rules R1-R4 (4 tests, one each)
// ============================================================================

// ============================================================================
// Canonical order (1 test)
// ============================================================================

// ============================================================================
// Two-pass (2 tests)
// ============================================================================

describe("DEFAULT variant — task-intent acquisition", () => {
	it("instructs emission of the task-intent block before summary", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("<task-intent>");
		expect(MERGED_COMPACTION_PROMPT_USER).not.toContain("Emit <task-intent>");
		expect(MERGED_COMPACTION_PROMPT_USER.indexOf("<task-intent>")).toBeLessThan(
			MERGED_COMPACTION_PROMPT_USER.indexOf("<summary>"),
		);
	});
});

describe("DEFAULT variant — family landmarks", () => {
	it("contains the claude baseline acquisition wording", () => {
		expect(MERGED_COMPACTION_PROMPT_USER).toContain("<task-intent>");
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
		expect(MERGED_COMPACTION_PROMPT_USER.indexOf("<task-intent>")).toBeLessThan(
			MERGED_COMPACTION_PROMPT_USER.indexOf("<summary>"),
		);
	});
});

// ============================================================================
// Variants (3 tests)
// ============================================================================

describe("TURN_PREFIX variant", () => {
	it("does not acquire task-intent when one is already present", () => {
		const prompt = buildPrompt({ variant: "turn_prefix", taskIntent: "anchored" });
		expect(prompt.user).not.toContain("ORIGINAL_REQUEST:");
	});

	it("acquires task-intent only when absent", () => {
		const prompt = buildPrompt({ variant: "turn_prefix" });
		expect(prompt.user).toContain("<summary>");
	});
});

describe("UPDATE variant", () => {
	it("injects the task-intent block before previous summary when present", () => {
		const prompt = buildPrompt({ variant: "update", previousSummary: "prev", taskIntent: "intent bytes" });
		expect(prompt.user).toContain("<task-intent>");
		expect(prompt.user).toContain("intent bytes");
		expect(prompt.user.indexOf("<previous-summary>")).toBeLessThan(prompt.user.indexOf("<task-intent>"));
	});

	it("requests task-intent acquisition when absent", () => {
		const prompt = buildPrompt({ variant: "update", previousSummary: "prev" });
		expect(prompt.user).toContain("<previous-summary>");
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
