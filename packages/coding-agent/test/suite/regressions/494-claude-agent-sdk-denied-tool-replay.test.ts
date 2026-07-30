import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildClaudeAgentSdkQueryOptions } from "../../../src/core/extensions/builtin/claude-agent-sdk/options.ts";

const MODEL: Model<Api> = {
	id: "claude-opus-5",
	name: "Claude Opus 5",
	api: "claude-agent-sdk",
	provider: "claude-agent-sdk",
	baseUrl: "claude-agent-sdk",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const CONTEXT: Context = { messages: [] };

describe("issue #494: Claude Agent SDK denied tool replay", () => {
	it("terminally denies native and custom MCP tools before Claude Code can execute or retry them", async () => {
		// Given: the inference-only SDK adapter options.
		const options = buildClaudeAgentSdkQueryOptions({
			model: MODEL,
			context: CONTEXT,
			cwd: "/tmp",
			providerSettings: { appendSystemPrompt: false },
			authLane: "oauth-slots",
		});

		// When: the SDK resolves its pre-execution hook for host-captured tools.
		const matcher = options.hooks?.PreToolUse?.[0];
		const hook = matcher?.hooks[0];
		if (matcher?.matcher === undefined || hook === undefined) {
			throw new Error("Expected a PreToolUse denial hook for host-captured tools");
		}
		const matches = new RegExp(`^(?:${matcher.matcher})$`);
		const output = await hook(
			{
				hook_event_name: "PreToolUse",
				session_id: "session-494",
				transcript_path: "/tmp/session-494.jsonl",
				cwd: "/tmp",
				tool_name: "Bash",
				tool_input: { command: "echo once >> probe.txt" },
				tool_use_id: "tool-494",
			},
			"tool-494",
			{ signal: new AbortController().signal },
		);

		// Then: every Senpi-captured SDK tool is intercepted with a terminal, non-inciting denial.
		expect(
			["Bash", "Write", "Edit", "Read", "Grep", "Glob", "mcp__custom-tools__eval"].every((name) =>
				matches.test(name),
			),
		).toBe(true);
		expect(matches.test("WebSearch")).toBe(false);
		expect(output).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: expect.stringMatching(/host.*do not retry/i),
			},
		});
	});
});
