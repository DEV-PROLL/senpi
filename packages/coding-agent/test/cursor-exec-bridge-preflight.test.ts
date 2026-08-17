import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createCursorExecBridge } from "../src/core/cursor-exec-bridge.ts";

function isToolResult(value: unknown): value is ToolResultMessage {
	return typeof value === "object" && value !== null && "role" in value && value.role === "toolResult";
}

describe("cursor exec bridge tool_call preflight", () => {
	it("returns loop-guard blocks for identical attempts 7-9 without executing them", async () => {
		const parameters = Type.Object({ path: Type.String(), content: Type.String() });
		const execute = vi.fn<AgentTool<typeof parameters>["execute"]>(async (_toolCallId, params) => ({
			content: [{ type: "text", text: params.content }],
			details: undefined,
		}));
		const tool: AgentTool<typeof parameters> = {
			name: "write",
			label: "write",
			description: "write test tool",
			parameters,
			execute,
		};
		const events: AgentEvent[] = [];
		let attempts = 0;
		const preflightToolCall = vi.fn(async (event: { input: Record<string, unknown> }) => {
			attempts++;
			if ("content" in event.input) {
				event.input.content = "mutated by tool_call";
			}
			return attempts >= 7
				? { block: true, reason: `Loop guard blocked attempt ${attempts}`, terminate: attempts === 9 }
				: undefined;
		});
		const bridge = createCursorExecBridge(
			Object.assign(
				{
					getTool: (name: string) => (name === "write" ? tool : undefined),
					emitEvent: (event: AgentEvent) => events.push(event),
				},
				{ preflightToolCall },
			),
		);

		const results: ToolResultMessage[] = [];
		for (let attempt = 1; attempt <= 9; attempt++) {
			const result = await bridge.piWrite?.({
				toolCallId: `call-${attempt}`,
				args: { $typeName: "agent.v1.PiWriteExecArgs", path: "same.ts", content: "same content" },
			});
			expect(isToolResult(result)).toBe(true);
			if (isToolResult(result)) results.push(result);
		}

		expect(preflightToolCall).toHaveBeenCalledTimes(9);
		expect(execute).toHaveBeenCalledTimes(6);
		expect(execute.mock.calls.map((call) => call[1])).toEqual(
			Array.from({ length: 6 }, () => ({ path: "same.ts", content: "mutated by tool_call" })),
		);
		expect(results.slice(0, 6).every((result) => result.isError === false)).toBe(true);
		expect(results.slice(6).map((result) => result.content[0])).toEqual([
			{ type: "text", text: "Loop guard blocked attempt 7" },
			{ type: "text", text: "Loop guard blocked attempt 8" },
			{ type: "text", text: "Loop guard blocked attempt 9" },
		]);
		expect(results.slice(6).every((result) => result.isError)).toBe(true);
		expect(events.map((event) => event.type)).toEqual(
			Array.from({ length: 9 }, () => ["tool_execution_start", "tool_execution_end"]).flat(),
		);
	});
});
