import { describe, expect, it } from "vitest";
import { RESERVED_SCHEMA_TOOL } from "../src/bridge/reserved.ts";
import { runEvalSchema } from "../src/bridges/schema-bridge.ts";
import { runJavaScriptCell, withJavaScriptKernel } from "./eval/js-kernel-harness.ts";

const BATCH_TOOL = {
	name: "mcp_computer_use_batch",
	description: "Run 1-20 canonical steps.",
	parameters: {
		type: "object",
		properties: { steps: { type: "array", items: { type: "object" } } },
		required: ["steps"],
	},
} as const;

describe("schema() inside a real JavaScript kernel", () => {
	it("routes through the reserved schema bridge and returns the parameter schema", async () => {
		const seen: { toolName?: string; args?: unknown } = {};

		const value = await withJavaScriptKernel(async (kernel) => {
			const answered = (async () => {
				const call = await kernel.nextToolCall();
				seen.toolName = call.toolName;
				seen.args = call.args;
				kernel.deliverToolReply({
					type: "tool-reply",
					callId: call.callId,
					ok: true,
					value: runEvalSchema(call.args, { listTools: () => [BATCH_TOOL] }),
				});
			})();
			const run = await runJavaScriptCell(
				kernel,
				'return JSON.stringify(await tool_schema("mcp_computer_use_batch"));',
				10_000,
			);
			await answered;
			if (!run.result.ok) throw new Error(run.result.error.message);
			return run.result.valueRepr;
		});

		expect(seen.toolName).toBe(RESERVED_SCHEMA_TOOL);
		expect(seen.args).toEqual({ name: "mcp_computer_use_batch" });
		expect(String(value)).toContain("steps");
		expect(String(value)).toContain("mcp_computer_use_batch");
	});
});
