import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
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

function sensitiveModel(id = "claude-fable-5", provider = "anthropic"): Model<Api> {
	return {
		id,
		provider,
		reasoning: true,
		api: "anthropic-messages",
		contextWindow: 200_000,
		maxTokens: 8192,
	} as unknown as Model<Api>;
}

function plainModel(): Model<Api> {
	return getModel("anthropic", "claude-sonnet-4-5")!;
}

function warningEvents(events: AgentSessionEvent[]): AgentSessionEvent[] {
	return events.filter((e) => e.type === "high_reasoning_warning");
}

describe("AgentSession high_reasoning_warning event", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-hrw-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) session.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	async function createSession(initialModel: Model<Api> = plainModel()): Promise<{
		session: AgentSession;
		events: AgentSessionEvent[];
	}> {
		const events: AgentSessionEvent[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: initialModel, systemPrompt: "Test", tools: [] },
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
		session.subscribe((event) => {
			events.push(event);
		});
		return { session, events };
	}

	it("emits high_reasoning_warning when a sensitive model is raised to xhigh", async () => {
		const { session, events } = await createSession();
		session.agent.state.model = sensitiveModel();
		session.setThinkingLevel("xhigh");
		expect(warningEvents(events).length).toBe(1);
		const e = warningEvents(events)[0] as { type: string; modelId: string; provider: string; thinkingLevel: string };
		expect(e.type).toBe("high_reasoning_warning");
		expect(e.modelId).toBe("claude-fable-5");
		expect(e.provider).toBe("anthropic");
		expect(e.thinkingLevel).toBe("xhigh");
	});

	it("does not emit when a sensitive model is set to high (not 'above high')", async () => {
		const { session, events } = await createSession();
		session.agent.state.model = sensitiveModel();
		session.setThinkingLevel("high");
		expect(warningEvents(events).length).toBe(0);
	});

	it("does not emit when a non-sensitive model is raised to xhigh", async () => {
		const { session, events } = await createSession(plainModel());
		session.setThinkingLevel("xhigh");
		expect(warningEvents(events).length).toBe(0);
	});

	it("dedupes: raising to xhigh twice emits exactly one warning", async () => {
		const { session, events } = await createSession();
		session.agent.state.model = sensitiveModel();
		session.setThinkingLevel("xhigh");
		session.setThinkingLevel("xhigh");
		expect(warningEvents(events).length).toBe(1);
	});

	it("emits when switching to a different sensitive model while already at xhigh", async () => {
		const { session, events } = await createSession();
		session.agent.state.model = sensitiveModel("claude-fable-5");
		session.setThinkingLevel("xhigh");
		expect(warningEvents(events).length).toBe(1);
		await session.setModel(sensitiveModel("claude-opus-4-8"));
		expect(warningEvents(events).length).toBe(2);
	});
});
