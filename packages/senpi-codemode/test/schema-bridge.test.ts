import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it, vi } from "vitest";
import { RESERVED_AGENT_TOOL, RESERVED_OUTPUT_TOOL, RESERVED_SCHEMA_TOOL } from "../src/bridge/reserved.ts";
import { isReservedToolName } from "../src/bridges/reserved-dispatch.ts";
import { runEvalSchema } from "../src/bridges/schema-bridge.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { errorResult, FakeKernel, FakeManager, fakeExtensionContext } from "./eval/fakes.ts";

const TOOLS = [
	{
		name: "mcp_computer_use_batch",
		description: "Run 1-20 canonical steps.",
		parameters: {
			type: "object",
			properties: { steps: { type: "array", items: { type: "object" } } },
			required: ["steps"],
		},
	},
	{ name: "grep", description: "Search files.", parameters: { type: "object", properties: {} } },
] as const;

const listTools = () => TOOLS;

describe("runEvalSchema", () => {
	it("returns the parameter schema for a known tool", () => {
		expect(runEvalSchema({ name: "mcp_computer_use_batch" }, { listTools })).toMatchObject({
			name: "mcp_computer_use_batch",
			parameters: { required: ["steps"] },
		});
	});

	it("lists tool names when no name is given", () => {
		expect(runEvalSchema({}, { listTools })).toMatchObject({ tools: ["mcp_computer_use_batch", "grep"] });
	});

	it("names partial matches when the tool is unknown", () => {
		expect(() => runEvalSchema({ name: "mcp_computer_use_batchh" }, { listTools })).toThrow(/mcp_computer_use_batch/);
	});

	it("rejects unexpected arguments", () => {
		expect(() => runEvalSchema({ nope: 1 }, { listTools })).toThrow(/invalid arguments/);
	});
});

describe("reserved bridge names", () => {
	it("keeps the three reserved names distinct and recognized", () => {
		expect(RESERVED_SCHEMA_TOOL).toBe("__schema__");
		expect(new Set([RESERVED_AGENT_TOOL, RESERVED_OUTPUT_TOOL, RESERVED_SCHEMA_TOOL]).size).toBe(3);
		expect(isReservedToolName(RESERVED_SCHEMA_TOOL)).toBe(true);
		expect(isReservedToolName("grep")).toBe(false);
	});
});

describe("cell-handler dispatch for the reserved schema tool", () => {
	it("answers from listTools without executing any tool", async () => {
		const kernel = new FakeKernel([
			{
				type: "tool-call",
				callId: "call-schema",
				toolName: RESERVED_SCHEMA_TOOL,
				args: { name: "mcp_computer_use_batch" },
			},
			errorResult("cell-1", "done"),
		]);
		const executeTool = Object.assign(
			vi.fn(async (): Promise<AgentToolResult<unknown>> => {
				throw new Error("tool_schema() must not execute a tool");
			}),
			{ isToolAvailable: () => true },
		);
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool,
			listTools,
		});

		await tool.execute(
			"cell-1",
			{ language: "js", code: 'await tool_schema("mcp_computer_use_batch")', summary: "schema probe" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(executeTool).not.toHaveBeenCalled();
		expect(kernel.replies.at(-1)).toMatchObject({
			ok: true,
			value: { name: "mcp_computer_use_batch", parameters: { required: ["steps"] } },
		});
	});
});
