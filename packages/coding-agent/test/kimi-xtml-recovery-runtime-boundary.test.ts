import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream as AssistantStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
	Type,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const tools: Context["tools"] = [
	{ name: "Echo", description: "Echo text", parameters: Type.Object({ value: Type.String() }) },
];

function model(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "runtime-recovery",
		baseUrl: "https://example.test/v1",
		reasoning: false,
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

function leakingStream(selected: Model<Api>, text: string): AssistantStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const partial = blankMessage(selected);
		stream.push({ type: "start", partial });
		partial.content = [{ type: "text", text: "" }];
		stream.push({ type: "text_start", contentIndex: 0, partial });
		const mid = Math.ceil(text.length / 2);
		partial.content = [{ type: "text", text: text.slice(0, mid) }];
		stream.push({ type: "text_delta", contentIndex: 0, delta: text.slice(0, mid), partial });
		partial.content = [{ type: "text", text }];
		stream.push({ type: "text_delta", contentIndex: 0, delta: text.slice(mid), partial });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
		const message = blankMessage(selected);
		message.content = [{ type: "text", text }];
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

async function runtimeWithModel(id: string, text: string): Promise<AssistantMessage> {
	const selectedModel = model(id);
	const provider: Provider = {
		id: selectedModel.provider,
		name: "Boundary provider",
		auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test" }, source: "test" }) } },
		getModels: () => [selectedModel],
		stream: (selected) => leakingStream(selected, text),
		streamSimple: (selected) => leakingStream(selected, text),
	};
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(provider);
	const selected = runtime.getModel(provider.id, selectedModel.id);
	if (!selected) throw new Error("model not registered");
	return runtime.stream(selected, { messages: [], tools }).result();
}

const LEAKED_XTML = [
	"Checking the weather.",
	"<|close|>think<|sep|><|open|>response<|sep|>",
	"Sure, one moment.",
	"<|open|>tools<|sep|>",
	'<|open|>call tool="Echo" index="1"<|sep|>',
	'<|open|>argument key="value" type="string"<|sep|>hello<|close|>argument<|sep|>',
	"<|close|>call<|sep|>",
	"<|close|>tools<|sep|>",
	"Done.",
].join("");

describe("kimi model runtime XTML recovery", () => {
	it("recovers leaked XTML into an executable tool call for kimi models", async () => {
		// When
		const result = await runtimeWithModel("kimi-k3", LEAKED_XTML);

		// Then
		const toolCall = result.content.find((item) => item.type === "toolCall");
		expect(toolCall).toMatchObject({ type: "toolCall", name: "Echo", arguments: { value: "hello" } });
		const visibleText = result.content
			.filter((item) => item.type === "text")
			.map((item) => (item.type === "text" ? item.text : ""))
			.join("");
		expect(visibleText).toContain("Sure, one moment.");
		expect(visibleText).toContain("Done.");
		expect(visibleText).not.toContain("<|");
	});

	it("leaves non-kimi models without recovery untouched", async () => {
		// When
		const result = await runtimeWithModel("gpt-5", LEAKED_XTML);

		// Then
		expect(result.content.some((item) => item.type === "toolCall")).toBe(false);
		const visibleText = result.content
			.filter((item) => item.type === "text")
			.map((item) => (item.type === "text" ? item.text : ""))
			.join("");
		expect(visibleText).toContain("<|open|>tools<|sep|>");
	});
});
