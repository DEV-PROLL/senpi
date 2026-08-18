import type { AssistantMessage, Message, Model, ThinkingSelection } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { agentLoop } from "../src/agent-loop.ts";
import { streamProxy } from "../src/proxy.ts";
import type { AgentContext, AgentLoopConfig, AgentTool } from "../src/types.ts";

function testModel(): Model<"cursor-agent"> {
	return {
		id: "kimi-k3",
		name: "Kimi K3",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 64000,
	};
}

const explicitHigh: ThinkingSelection = { level: "high", source: "explicit" };

function assistantMessage(stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor-agent",
		provider: "cursor",
		model: "kimi-k3",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

const echoParameters = Type.Object({ command: Type.String() });
const echoTool: AgentTool<typeof echoParameters> = {
	name: "bash",
	label: "bash",
	description: "run",
	parameters: echoParameters,
	execute: async () => ({ content: [{ type: "text", text: "ran" }], details: {} }),
};

function streamOnce(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
	stream.end();
	return stream;
}

describe("agent loop thinkingSelection transitions", () => {
	it("applies value, null, and undefined prepareNextTurn updates across iterations", async () => {
		const seen: (ThinkingSelection | undefined)[] = [];
		const updates: (ThinkingSelection | null | undefined)[] = [
			{ level: "max", source: "explicit" },
			null,
			undefined,
		];
		const toolCallMessage = assistantMessage("toolUse", [
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "true" } },
		]);
		const stopMessage = assistantMessage("stop", [{ type: "text", text: "done" }]);
		let call = 0;
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [echoTool] };
		const config: AgentLoopConfig = {
			model: testModel(),
			convertToLlm: (messages) => messages.filter((message): message is Message => "role" in message),
			thinkingSelection: explicitHigh,
			prepareNextTurn: () => ({ thinkingSelection: updates[call - 1] }),
		};
		const stream = agentLoop(
			[{ role: "user", content: "go", timestamp: 0 }],
			context,
			config,
			undefined,
			(_model, _context, options) => {
				seen.push(options?.thinkingSelection);
				call += 1;
				return streamOnce(call <= 2 ? toolCallMessage : stopMessage);
			},
		);
		await stream.result();
		expect(seen).toEqual([explicitHigh, { level: "max", source: "explicit" }, undefined]);
	});
});

describe("thinking selection propagation", () => {
	it("passes thinkingSelection from agent state into the loop config", () => {
		const agent = new Agent({ streamFn: () => {
			throw new Error("unused");
		} });
		agent.state.model = testModel();
		agent.state.thinkingLevel = "high";
		agent.state.thinkingSelection = explicitHigh;
		const config = agent.createLoopConfig();
		expect(config.reasoning).toBe("high");
		expect(config.thinkingSelection).toBe(explicitHigh);
	});

	it("keeps reasoning undefined for off while preserving explicit off selection", () => {
		const agent = new Agent({ streamFn: () => {
			throw new Error("unused");
		} });
		agent.state.model = testModel();
		agent.state.thinkingLevel = "off";
		const offSelection: ThinkingSelection = { level: "off", source: "explicit" };
		agent.state.thinkingSelection = offSelection;
		const config = agent.createLoopConfig();
		expect(config.reasoning).toBeUndefined();
		expect(config.thinkingSelection).toBe(offSelection);
	});

	it("leaves thinkingSelection undefined when nothing was explicitly selected", () => {
		const agent = new Agent({ streamFn: () => {
			throw new Error("unused");
		} });
		agent.state.model = testModel();
		agent.state.thinkingLevel = "medium";
		const config = agent.createLoopConfig();
		expect(config.reasoning).toBe("medium");
		expect(config.thinkingSelection).toBeUndefined();
	});

	it("serializes thinkingSelection into proxy request options", async () => {
		const options = {
			reasoning: "high" as const,
			thinkingSelection: { level: "off", source: "legacy-variant", legacyVariantId: "gpt-5.6-luna-none" } as ThinkingSelection,
			authToken: "token",
			proxyUrl: "https://proxy.example.com",
		};
		const seen: unknown[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
			seen.push(typeof init?.body === "string" ? JSON.parse(init.body) : init?.body);
			return new Response("data: {\"type\":\"error\",\"reason\":\"error\",\"errorMessage\":\"closed\"}\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;
		try {
			await streamProxy(testModel(), { messages: [] }, options).result();
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(seen).toHaveLength(1);
		const body = seen[0] as { options?: Record<string, unknown> };
		expect(body?.options?.thinkingSelection).toEqual({
			level: "off",
			source: "legacy-variant",
			legacyVariantId: "gpt-5.6-luna-none",
		});
	});
});
