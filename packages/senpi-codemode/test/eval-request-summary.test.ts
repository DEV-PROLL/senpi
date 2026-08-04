import { type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { clampEvalSummary, isEvalControlRequest, parseEvalRequest } from "../src/tool/eval-request.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { EVAL_SUMMARY_MAX_LENGTH, type EvalToolInput, type EvalToolRequest } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

const TEACHING_ERROR =
	"eval run requires summary — one line in the user's language: what this cell does and for what purpose";
const SUMMARY_SCHEMA_DESCRIPTION =
	"REQUIRED for run. ONE line in the USER'S conversational language (Korean conversation -> Korean summary) stating WHAT this cell does and FOR WHAT PURPOSE; shown in the TUI while the cell runs. Longer values are force-truncated to 80 chars.";

type EvalTool = ReturnType<typeof createEvalTool>;

function buildTool(): EvalTool {
	const kernel = new FakeKernel([result("cell-1", "1", 1)]);
	return createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 30,
		executeTool: vi.fn(),
	});
}

function parseRun(params: unknown): EvalToolInput {
	const parsed = parseEvalRequest(params);
	if (isEvalControlRequest(parsed)) throw new Error("expected a run request");
	return parsed;
}

function parseError(params: unknown): TypeError {
	try {
		parseEvalRequest(params);
	} catch (error) {
		expect(error).toBeInstanceOf(TypeError);
		return error as TypeError;
	}
	throw new Error("expected parseEvalRequest to throw");
}

function prepareEvalArguments(tool: EvalTool, args: unknown): Record<string, unknown> {
	const prepare = tool.prepareArguments;
	if (prepare === undefined) throw new Error("eval tool must define prepareArguments");
	return { ...prepare(args) };
}

function validatePrepared(tool: EvalTool, prepared: Record<string, unknown>): Record<string, unknown> {
	const toolCall: ToolCall = { type: "toolCall", id: "call-1", name: "eval", arguments: prepared };
	return validateToolArguments(tool, toolCall) as Record<string, unknown>;
}

describe("clampEvalSummary", () => {
	it("returns undefined for non-string values", () => {
		expect(clampEvalSummary(undefined)).toBeUndefined();
		expect(clampEvalSummary(null)).toBeUndefined();
		expect(clampEvalSummary(42)).toBeUndefined();
		expect(clampEvalSummary(true)).toBeUndefined();
		expect(clampEvalSummary({})).toBeUndefined();
	});

	it("trims and collapses internal whitespace", () => {
		expect(clampEvalSummary("  a   b  ")).toBe("a b");
		expect(clampEvalSummary("a\n\tb   c")).toBe("a b c");
	});

	it("returns undefined for empty or whitespace-only values", () => {
		expect(clampEvalSummary("")).toBeUndefined();
		expect(clampEvalSummary("   ")).toBeUndefined();
	});

	it("passes through values within the limit unchanged", () => {
		const exact = "x".repeat(EVAL_SUMMARY_MAX_LENGTH);
		expect(clampEvalSummary(exact)).toBe(exact);
		expect(clampEvalSummary("check legacyClient usage")).toBe("check legacyClient usage");
	});

	it("force-truncates over-limit values to 80 chars ending in ellipsis", () => {
		const clamped = clampEvalSummary("y".repeat(81));
		expect(clamped).toBe(`${"y".repeat(77)}...`);
		expect(clamped).toHaveLength(EVAL_SUMMARY_MAX_LENGTH);
	});
});

describe("parseEvalRequest summary enforcement", () => {
	it("throws the teaching error when a run omits summary", () => {
		expect(parseError({ language: "py", code: "print(1)" }).message).toBe(TEACHING_ERROR);
	});

	it("throws the teaching error when a run summary is empty, blank, or non-string", () => {
		expect(parseError({ language: "py", code: "print(1)", summary: "" }).message).toBe(TEACHING_ERROR);
		expect(parseError({ language: "py", code: "print(1)", summary: "   " }).message).toBe(TEACHING_ERROR);
		expect(parseError({ language: "py", code: "print(1)", summary: 42 }).message).toBe(TEACHING_ERROR);
	});

	it("throws the teaching error for an explicit run action without summary", () => {
		expect(parseError({ action: "run", language: "py", code: "print(1)" }).message).toBe(TEACHING_ERROR);
	});

	it("passes through summaries within the limit", () => {
		const parsed = parseRun({ language: "py", code: "print(1)", summary: "집계 셀 실행" });
		expect(parsed.summary).toBe("집계 셀 실행");
	});

	it("collapses whitespace in summaries", () => {
		expect(parseRun({ language: "py", code: "print(1)", summary: "  a   b  " }).summary).toBe("a b");
	});

	it("clamps over-limit summaries to 80 chars ending in ellipsis", () => {
		const parsed = parseRun({ language: "py", code: "print(1)", summary: "s".repeat(120) });
		expect(parsed.summary).toHaveLength(EVAL_SUMMARY_MAX_LENGTH);
		expect(parsed.summary.endsWith("...")).toBe(true);
	});

	it("accepts peek and stop without a summary and ignores a provided one", () => {
		expect(parseEvalRequest({ action: "peek", cell_id: "cell-1" })).toEqual({ action: "peek", cell_id: "cell-1" });
		expect(parseEvalRequest({ action: "stop", cell_id: "cell-1" })).toEqual({ action: "stop", cell_id: "cell-1" });
		expect(parseEvalRequest({ action: "peek", cell_id: "cell-1", summary: "ignored" })).toEqual({
			action: "peek",
			cell_id: "cell-1",
		});
	});

	it("parses legacy title-bearing runs with title absent from the result", () => {
		const parsed = parseRun({ title: "legacy label", summary: "kept summary", language: "py", code: "print(1)" });
		expect(parsed).toEqual({ language: "py", code: "print(1)", summary: "kept summary" });
		expect("title" in parsed).toBe(false);
	});
});

describe("eval tool schema", () => {
	it("describes summary with the verbatim required-for-run guide", () => {
		const tool = buildTool();
		const summary = tool.parameters.properties.summary;
		expect(summary.description).toContain(SUMMARY_SCHEMA_DESCRIPTION);
		expect(summary.maxLength).toBe(EVAL_SUMMARY_MAX_LENGTH);
	});

	it("removes title from the input schema", () => {
		const tool = buildTool();
		expect("title" in tool.parameters.properties).toBe(false);
	});
});

describe("eval tool prepareArguments", () => {
	it("clamps a 500-char summary before schema validation", () => {
		const tool = buildTool();
		const prepared = prepareEvalArguments(tool, {
			language: "js",
			code: "return 1",
			summary: "s".repeat(500),
		});
		expect(prepared.summary).toBe(`${"s".repeat(77)}...`);
		const validated = validatePrepared(tool, prepared);
		expect(validated.summary).toBe(prepared.summary);
	});

	it("schema validation alone rejects the over-limit summary the clamp prevents", () => {
		const tool = buildTool();
		expect(() => validatePrepared(tool, { language: "js", code: "return 1", summary: "s".repeat(500) })).toThrow(
			/summary/,
		);
	});

	it("drops an empty summary instead of failing validation", () => {
		const tool = buildTool();
		const prepared = prepareEvalArguments(tool, { language: "js", code: "return 1", summary: "   " });
		expect("summary" in prepared).toBe(false);
	});

	it("passes peek and stop arguments through untouched", () => {
		const tool = buildTool();
		const prepared = prepareEvalArguments(tool, { action: "peek", cell_id: "cell-9", summary: "  padded  " });
		expect(prepared).toEqual({ action: "peek", cell_id: "cell-9", summary: "  padded  " });
	});

	it("keeps legacy title props and still validates", () => {
		const tool = buildTool();
		const prepared = prepareEvalArguments(tool, {
			language: "js",
			code: "return 1",
			summary: "legacy caller",
			title: "old label",
		});
		expect(prepared.title).toBe("old label");
		const validated = validatePrepared(tool, prepared);
		expect(validated.title).toBe("old label");
		expect(validated.summary).toBe("legacy caller");
	});
});

describe("eval tool execute error path", () => {
	it("surfaces the teaching error as a tool error when summary is missing", async () => {
		const tool = buildTool();
		const call = tool.execute(
			"cell-1",
			{ language: "js", code: "return 42" } as unknown as EvalToolRequest,
			undefined,
			undefined,
			fakeExtensionContext(),
		);
		await expect(call).rejects.toThrowError(TypeError);
		await expect(call).rejects.toThrow(TEACHING_ERROR);
	});
});
