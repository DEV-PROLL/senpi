import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { HOST_TOOL_DENIAL_HOOKS } from "../../../src/core/extensions/builtin/claude-agent-sdk/tools.ts";

type ProbeObservation = {
	providerRequests: number;
	sawToolResult: boolean;
	streamedToolName: string | null;
	permissionPrompts: number;
	customHandlerRuns: number;
	terminalReason: string | null;
	resultSubtype: string | null;
};

function sse(events: Array<[string, unknown]>): string {
	return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function toolUseTurn(toolName: string): string {
	return sse([
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_probe",
					type: "message",
					role: "assistant",
					model: "mock",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 1 },
				},
			},
		],
		[
			"content_block_start",
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_1", name: toolName, input: {} },
			},
		],
		[
			"content_block_delta",
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"command":"echo hi"}' },
			},
		],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "tool_use", stop_sequence: null },
				usage: { output_tokens: 4 },
			},
		],
		["message_stop", { type: "message_stop" }],
	]);
}

const endTurn = sse([
	[
		"message_start",
		{
			type: "message_start",
			message: {
				id: "msg_probe_2",
				type: "message",
				role: "assistant",
				model: "mock",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 20, output_tokens: 1 },
			},
		},
	],
	["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
	["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }],
	["content_block_stop", { type: "content_block_stop", index: 0 }],
	[
		"message_delta",
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
	],
	["message_stop", { type: "message_stop" }],
]);

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

async function runInstalledSdkTurn(toolName: string): Promise<ProbeObservation> {
	const requestBodies: string[] = [];
	const server = createServer((req, res) => {
		if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString("utf8");
			});
			req.on("end", () => {
				requestBodies.push(body);
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(requestBodies.length === 1 ? toolUseTurn(toolName) : endTurn);
			});
			return;
		}
		res.writeHead(200, { "content-type": "application/json" }).end("{}");
	});
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		let permissionPrompts = 0;
		let customHandlerRuns = 0;
		let streamedToolName: string | null = null;
		let terminalReason: string | null = null;
		let resultSubtype: string | null = null;
		const stream = query({
			prompt: "Call the requested tool exactly once, then stop.",
			options: {
				cwd: "/tmp",
				model: "opus",
				hooks: HOST_TOOL_DENIAL_HOOKS,
				// Mirrors the production adapter: custom Pi tools are exposed through an
				// in-process SDK MCP server, so PreToolUse hooks match mcp__custom-tools__*.
				mcpServers: {
					"custom-tools": createSdkMcpServer({
						name: "custom-tools",
						tools: [
							tool("eval", "regression probe custom tool", {}, async () => {
								customHandlerRuns++;
								return { content: [{ type: "text" as const, text: "ok" }] };
							}),
						],
					}),
				},
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				settingSources: [],
				maxTurns: 5,
				canUseTool: async () => {
					permissionPrompts++;
					return { behavior: "allow", updatedInput: {} };
				},
				env: {
					...process.env,
					ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
					ANTHROPIC_API_KEY: "regression-probe-key",
					CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				},
			},
		});
		for await (const message of stream) {
			if (message.type === "assistant") {
				for (const block of message.message.content) {
					if (block.type === "tool_use") streamedToolName = block.name;
				}
			}
			if (message.type === "result") {
				resultSubtype = message.subtype;
				terminalReason = message.terminal_reason ?? null;
			}
		}
		return {
			providerRequests: requestBodies.length,
			sawToolResult: requestBodies.some((body) => body.includes('"type":"tool_result"')),
			streamedToolName,
			permissionPrompts,
			customHandlerRuns,
			terminalReason,
			resultSubtype,
		};
	} finally {
		await closeServer(server);
	}
}

describe("issue #494: installed Claude Agent SDK terminal hook stop", () => {
	it.each(["Bash", "mcp__custom-tools__eval"])(
		"stops %s after exactly one provider request with terminal_reason hook_stopped",
		async (toolName) => {
			// Given: a local ephemeral Anthropic-compatible endpoint that streams one tool call.
			// When: the installed SDK runs a turn guarded by Senpi's host-tool denial hooks.
			const observation = await runInstalledSdkTurn(toolName);

			// Then: the denial is terminal. The streamed tool call was observed by the SDK,
			// but the hook stopped the turn before any native or custom-MCP tool handler ran,
			// so no tool result and no second provider request ever happen.
			expect(observation.streamedToolName).toBe(toolName);
			expect(observation.permissionPrompts).toBe(0);
			expect(observation.customHandlerRuns).toBe(0);
			expect(observation.providerRequests).toBe(1);
			expect(observation.sawToolResult).toBe(false);
			expect(observation.terminalReason).toBe("hook_stopped");
			expect(observation.resultSubtype).toBe("success");
		},
		120_000,
	);
});
