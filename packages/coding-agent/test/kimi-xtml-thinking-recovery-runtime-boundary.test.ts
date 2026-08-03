import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream as AssistantStream,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function model(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "thinking-recovery",
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function blankMessage(selected: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		api: selected.api,
		provider: selected.provider,
		model: selected.id,
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function thinkingStream(selected: Model<Api>, chunks: readonly string[]): AssistantStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const partial = blankMessage(selected);
		stream.push({ type: "start", partial });
		partial.content = [{ type: "thinking", thinking: "" }];
		stream.push({ type: "thinking_start", contentIndex: 0, partial });
		let thinking = "";
		for (const chunk of chunks) {
			thinking += chunk;
			partial.content = [{ type: "thinking", thinking }];
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: chunk, partial });
		}
		stream.push({ type: "thinking_end", contentIndex: 0, content: thinking, partial });
		const message = blankMessage(selected);
		message.content = [{ type: "thinking", thinking }];
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

async function runtimeResult(id: string, chunks: readonly string[]): Promise<AssistantMessage> {
	const selectedModel = model(id);
	const provider: Provider = {
		id: selectedModel.provider,
		name: "Thinking recovery provider",
		auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test" }, source: "test" }) } },
		getModels: () => [selectedModel],
		stream: (selected) => thinkingStream(selected, chunks),
		streamSimple: (selected) => thinkingStream(selected, chunks),
	};
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(provider);
	const selected = runtime.getModel(provider.id, selectedModel.id);
	if (!selected) throw new Error("model not registered");
	return runtime.stream(selected, { messages: [], tools: [] }).result();
}

function visibleText(message: AssistantMessage): string {
	return message.content
		.filter((item) => item.type === "text")
		.map((item) => (item.type === "text" ? item.text : ""))
		.join("");
}

function thinkingText(message: AssistantMessage): string {
	return message.content
		.filter((item) => item.type === "thinking")
		.map((item) => (item.type === "thinking" ? item.thinking : ""))
		.join("");
}

describe("Kimi XTML thinking recovery runtime boundary", () => {
	it("promotes an explicit response channel without registered tools", async () => {
		const result = await runtimeResult("kimi-k3", [
			"Reasoning stays private.",
			"<|close|>think<|sep|><|open|>res",
			"ponse<|sep|>Recovered answer",
			"<|close|>response<|sep|><|close|>message<|sep|>",
		]);

		expect(visibleText(result)).toBe("Recovered answer");
		expect(thinkingText(result)).toBe("Reasoning stays private.");
		expect(result.content.map((item) => JSON.stringify(item)).join("")).not.toContain("<|");
		expect(result.diagnostics).toEqual([
			{
				type: "kimi_xtml_thinking_recovery",
				timestamp: expect.any(Number),
				details: { recoveredResponse: true },
			},
		]);
	});

	it("sanitizes closing-only markers without exposing thinking", async () => {
		const result = await runtimeResult("kimi-k3-ultrafast", [
			"Reasoning and a misrouted report stay private",
			".<|close|>response<|sep|><|close|>message<|sep|>",
		]);

		expect(visibleText(result)).toBe("");
		expect(thinkingText(result)).toBe("Reasoning and a misrouted report stay private.");
		expect(result.content.map((item) => JSON.stringify(item)).join("")).not.toContain("<|");
	});

	it("preserves XTML-looking literals inside fenced code", async () => {
		const literal = [
			"Example:\n```text\n",
			"<|close|>think<|sep|><|open|>response<|sep|>",
			"literal<|close|>response<|sep|><|close|>message<|sep|>\n```",
		];
		const result = await runtimeResult("kimi-k3", literal);

		expect(visibleText(result)).toBe("");
		expect(thinkingText(result)).toBe(literal.join(""));
		expect(result.diagnostics).toBeUndefined();
	});

	it("leaves ordinary Kimi thinking unchanged", async () => {
		const result = await runtimeResult("kimi-k3", ["Ordinary reasoning without protocol markers."]);

		expect(visibleText(result)).toBe("");
		expect(thinkingText(result)).toBe("Ordinary reasoning without protocol markers.");
		expect(result.diagnostics).toBeUndefined();
	});

	it("leaves non-Kimi thinking markers untouched", async () => {
		const leaked = "<|close|>think<|sep|><|open|>response<|sep|>Visible?<|close|>response<|sep|>";
		const result = await runtimeResult("gpt-5", [leaked]);

		expect(visibleText(result)).toBe("");
		expect(thinkingText(result)).toBe(leaked);
		expect(result.diagnostics).toBeUndefined();
	});
});
