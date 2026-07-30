import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createRpcEventOutputBuffer } from "../src/modes/rpc/event-output-buffer.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function sensitiveModel(): Model<Api> {
	return {
		id: "claude-fable-5",
		provider: "anthropic",
		reasoning: true,
		api: "anthropic-messages",
		contextWindow: 200_000,
		maxTokens: 8192,
	} as unknown as Model<Api>;
}

describe("RPC publishes high_reasoning_warning", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-hrw-rpc-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) session.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	it("serializes the event onto the RPC stdout sink via the real output buffer", async () => {
		const sinkChunks: string[] = [];
		const scheduledFlushes: Array<() => void> = [];
		const eventOutput = createRpcEventOutputBuffer(
			(chunk) => sinkChunks.push(chunk),
			(flush) => scheduledFlushes.push(flush),
		);
		const outputEvent = (event: object) => eventOutput.enqueueEvent(event);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: sensitiveModel(), systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const msg: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "mock",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		session.subscribe((event) => outputEvent(event));
		session.setThinkingLevel("xhigh");
		for (const flush of scheduledFlushes) flush();

		const lines = sinkChunks
			.join("")
			.split("\n")
			.filter((line) => line.length > 0);
		const warning = lines
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.find((record) => record.type === "high_reasoning_warning");

		expect(warning).toBeDefined();
		expect(warning?.modelId).toBe("claude-fable-5");
		expect(warning?.provider).toBe("anthropic");
		expect(warning?.thinkingLevel).toBe("xhigh");
	});
});
