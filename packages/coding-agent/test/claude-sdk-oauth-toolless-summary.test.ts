import { createAssistantMessageEventStream, type Api, type AssistantMessageEventStream, type Context, type Model, type Tool } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { generateSummaryMessage } from "../src/core/extensions/builtin/compaction/speculative-summary.ts";
import {
	BUILTIN_SDK_TOOLS,
	CUSTOM_TOOLS_MCP_SERVER_NAME,
} from "../src/core/extensions/builtin/claude-sdk-oauth/tools.ts";
import { buildClaudeSdkOauthQueryOptions } from "../src/core/extensions/builtin/claude-sdk-oauth/options.ts";
import { resetSdkBoundary, overrideSdkBoundary, type Options, type SDKMessage } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { streamClaudeSdkOauth } from "../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";

const model: Model<Api> = {
	id: "claude-sonnet-4-6",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "claude-sdk-oauth",
	baseUrl: "claude-sdk-oauth",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const customTool: Tool = {
	name: "lookup",
	description: "Look something up",
	parameters: { type: "object", properties: { query: { type: "string" } } },
};

function context(tools?: Tool[]): Context {
	return { messages: [], ...(tools ? { tools } : {}) };
}

function successfulResult(result: string): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		result,
		stop_reason: "end_turn",
		usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	} as SDKMessage;
}

async function collect(stream: AsyncIterable<unknown>): Promise<void> {
	for await (const _event of stream) {
		// Drain the provider stream before reading its result.
	}
}

afterEach(() => resetSdkBoundary());

describe("claude-sdk-oauth tool-less requests", () => {
	it("builds no SDK tools for toolChoice none while preserving normal tool options", () => {
		const normal = buildClaudeSdkOauthQueryOptions({
			model,
			context: context([customTool]),
			tools: ["mcp__custom-tools__lookup"],
			providerSettings: {},
		});
		const toolLess = buildClaudeSdkOauthQueryOptions({
			model,
			context: context([customTool]),
			tools: ["mcp__custom-tools__lookup"],
			providerSettings: {},
			streamOptions: { toolChoice: "none" },
		});

		expect(normal.tools).toEqual(["mcp__custom-tools__lookup"]);
		expect(toolLess.tools).toEqual([]);
		expect(toolLess.mcpServers).toBeUndefined();
		expect(toolLess).not.toHaveProperty(CUSTOM_TOOLS_MCP_SERVER_NAME);
		expect(
			buildClaudeSdkOauthQueryOptions({ model, context: context(), providerSettings: {} }).tools,
		).toEqual([...BUILTIN_SDK_TOOLS]);
	});

	it("does not attach custom MCP tools to a tool-less stream", async () => {
		const calls: Options[] = [];
		overrideSdkBoundary({
			createSdkMcpServer: () => ({}) as never,
			query: (input) => {
				calls.push(input.options ?? {});
				return {
					async *[Symbol.asyncIterator]() {
						yield successfulResult("summary");
					},
					interrupt: async () => {},
					close: () => {},
				};
			},
		});

		const stream = streamClaudeSdkOauth(model, context([customTool]), { toolChoice: "none", streamKind: "auxiliary" });
		await collect(stream);
		await stream.result();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.tools).toEqual([]);
		expect(calls[0]?.mcpServers).toBeUndefined();

		const normalStream = streamClaudeSdkOauth(model, context([customTool]), { streamKind: "auxiliary" });
		await collect(normalStream);
		await normalStream.result();
		expect(calls[1]?.tools).toEqual([]);
		expect(calls[1]?.mcpServers).toEqual({ "custom-tools": {} });
	});

	it("carries the summarizer retry through a claude-sdk-oauth runtime boundary", async () => {
		const calls: Options[] = [];
		const runtime = {
			stream: (_selectedModel: Model<Api>, requestContext: Context, streamOptions: Record<string, unknown>) => {
				const queryOptions = buildClaudeSdkOauthQueryOptions({
					model,
					context: requestContext,
					streamOptions: streamOptions as never,
					tools: requestContext.tools?.map((tool) => `mcp__custom-tools__${tool.name}`),
				});
				calls.push(queryOptions);
				const response = createAssistantMessageEventStream();
				const message = {
					role: "assistant",
					content: [{ type: "text", text: "recovered summary" }],
					api: "claude-sdk-oauth",
					provider: "claude-sdk-oauth",
					model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				};
				response.push({ type: "done", reason: "stop", message } as never);
				response.end();
				return response as AssistantMessageEventStream;
			},
		};
		const summaryContext = {
			modelRegistry: { modelRuntime: runtime },
		} as never;
		const snapshot = {
			model,
			contextWindow: 200_000,
			systemPrompt: "system",
			tools: [customTool],
		} as never;
		const result = await generateSummaryMessage({
			context: summaryContext,
			snapshot,
			messages: [],
			prompt: { system: "system", user: "summarize" },
			auth: {},
			forbidToolCalls: true,
		});

		expect(result && "content" in result ? result.content : result).toEqual([{ type: "text", text: "recovered summary" }]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.tools).toEqual([]);
	});
});
