import { describe, expect, it } from "vitest";
import { runInstalledSdkLocalTurn } from "../../helpers/claude-agent-sdk-local-probe.ts";

describe("issue #494: installed Claude Agent SDK terminal hook stop", () => {
	it.each(["Bash", "mcp__custom-tools__eval"])(
		"stops %s after exactly one provider request with terminal_reason hook_stopped",
		async (toolName) => {
			// Given: a local ephemeral Anthropic-compatible endpoint streaming one tool call,
			// the installed SDK + claude CLI under production dontAsk permission mode.
			// When: Senpi's host-tool PreToolUse denial hooks guard the turn.
			const observation = await runInstalledSdkLocalTurn(toolName);

			// Then: the streamed tool call reached the SDK as a raw stream event and as a
			// finalized assistant block, but the hook stopped the turn first - no permission
			// callback, no Bash command side effect, no custom MCP handler invocation, no
			// tool_result in the SDK stream or on the wire, and no second provider request.
			expect(observation.partialToolUseName).toBe(toolName);
			expect(observation.finalizedToolUseName).toBe(toolName);
			expect(observation.permissionPrompts).toBe(0);
			expect(observation.markerExists).toBe(false);
			expect(observation.customHandlerRuns).toBe(0);
			expect(observation.executedToolResults).toBe(0);
			expect(observation.providerSawToolResult).toBe(false);
			expect(observation.providerRequests).toBe(1);
			expect(observation.terminalReason).toBe("hook_stopped");
			expect(observation.resultSubtype).toBe("success");
		},
		120_000,
	);
});
