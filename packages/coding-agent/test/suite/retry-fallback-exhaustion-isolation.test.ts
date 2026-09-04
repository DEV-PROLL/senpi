import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { RetryFallbackExhaustedEvent } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

type RetryInternals = {
	readonly _retryFallback: {
		readonly activeState?: {
			readonly chainKey: string;
		};
	};
	_handleRetryableError: (
		message: ReturnType<typeof fauxAssistantMessage>,
		options: { hardErrorFallback: boolean },
	) => Promise<string>;
};

function retryInternals(harness: Harness): RetryInternals {
	return harness.session as unknown as RetryInternals;
}

function seedLiveContext(harness: Harness, tokens: number): void {
	const timestamp = Date.now();
	const primary = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "continue the interrupted task" }],
		timestamp: timestamp - 1,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "progress before provider failure" }],
		api: primary.api,
		provider: primary.provider,
		model: primary.id,
		stopReason: "stop",
		usage: {
			input: tokens - 1_000,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("retry fallback exhaustion isolation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("settles the retry while a notification-only exhaustion handler remains pending", async () => {
		// given
		let notifyStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		let releaseNotify: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			releaseNotify = resolve;
		});
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 4_000 },
				{ id: "faux-2", contextWindow: 80_000, maxTokens: 4_000 },
			],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
				},
			},
			extensionFactories: [
				(pi) => {
					pi.on("retry_fallback_exhausted", () => {
						notifyStarted?.();
						return pending;
					});
				},
			],
		});
		harnesses.push(harness);
		seedLiveContext(harness, 90_000);
		let settled = false;
		const retry = retryInternals(harness)
			._handleRetryableError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream unavailable" }),
				{ hardErrorFallback: true },
			)
			.then((result) => {
				settled = true;
				return result;
			});

		// when
		await started;

		// then
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				retry,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error("retry remained blocked by exhaustion handler")), 500);
				}),
			]);
			expect(result).toBe("not-handled");
			expect(settled).toBe(true);
		} finally {
			if (timeout) clearTimeout(timeout);
			releaseNotify?.();
			await retry;
		}
	});

	it("restores the original toolset when model-select handlers mutate and throw", async () => {
		// given
		const primaryTool: AgentTool = {
			name: "primary_tool",
			label: "Primary",
			description: "Primary model tool.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "primary" }], details: {} }),
		};
		const fallbackTool: AgentTool = {
			name: "fallback_tool",
			label: "Fallback",
			description: "oversized ".repeat(40_000),
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "fallback" }], details: {} }),
		};
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 4_000 },
				{ id: "faux-2", contextWindow: 80_000, maxTokens: 4_000 },
			],
			systemPrompt: "primary prompt",
			tools: [primaryTool, fallbackTool],
			initialActiveToolNames: ["primary_tool"],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
				},
			},
			extensionFactories: [
				(pi) => {
					pi.on("model_select", (event) => {
						if (event.model.id === "faux-2") pi.setActiveTools(["fallback_tool"]);
						throw new Error(`model-select failure for ${event.model.id}`);
					});
				},
			],
		});
		harnesses.push(harness);
		const originalSystemPrompt = harness.session.systemPrompt;

		// when
		await retryInternals(harness)._handleRetryableError(
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream unavailable" }),
			{ hardErrorFallback: true },
		);

		// then
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.session.systemPrompt).toBe(originalSystemPrompt);
		expect(harness.session.getActiveToolNames()).toEqual(["primary_tool"]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toEqual([]);
	});

	it("completes a fallback turn when post-commit observers throw", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 4_000 },
				{ id: "faux-2", contextWindow: 200_000, maxTokens: 4_000 },
			],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream unavailable" }),
			fauxAssistantMessage("fallback answer"),
		]);
		harness.session.subscribe((event) => {
			if (
				(event.type === "model_changed" && event.model.id === "faux-2") ||
				event.type === "retry_fallback_applied"
			) {
				throw new Error("observer failed after commit");
			}
		});

		// when
		await harness.session.prompt("complete through fallback");

		// then
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({ type: "model_change", modelId: "faux-2", reason: "fallback" }),
		);
		expect(retryInternals(harness)._retryFallback.activeState?.chainKey).toBe("faux/faux-1");
		expect(harness.session.isRetrying).toBe(false);
		const lastMessage = harness.sessionManager.buildSessionContext().messages.at(-1);
		if (lastMessage?.role !== "assistant") throw new Error("missing fallback assistant response");
		expect(lastMessage.content).toEqual([{ type: "text", text: "fallback answer" }]);
	});

	it("settles the public prompt lifecycle when fallback persistence fails", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 4_000 },
				{ id: "faux-2", contextWindow: 200_000, maxTokens: 4_000 },
			],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream unavailable" })]);
		const persist = Reflect.get(harness.sessionManager, "_persist");
		if (typeof persist !== "function") throw new Error("missing session persistence seam");
		Reflect.set(harness.sessionManager, "_persist", (entry: { readonly type: string }) => {
			if (entry.type === "model_change") throw new Error("disk full");
			return Reflect.apply(persist, harness.sessionManager, [entry]);
		});

		// when
		await harness.session.prompt("fail fallback persistence");

		// then
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toEqual([]);
	});

	it("bounds the extension exhaustion diagnostics", async () => {
		// given
		const extensionEvents: RetryFallbackExhaustedEvent[] = [];
		const fallbackIds = Array.from({ length: 24 }, (_, index) => `fallback-${index + 1}`);
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 4_000 },
				...fallbackIds.map((id) => ({ id, contextWindow: 80_000, maxTokens: 4_000 })),
			],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": fallbackIds.map((id) => `faux/${id}`) },
				},
			},
			extensionFactories: [
				(pi) => {
					pi.on("retry_fallback_exhausted", (event) => {
						extensionEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		seedLiveContext(harness, 90_000);

		// when
		await retryInternals(harness)._handleRetryableError(
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "x".repeat(20_000) }),
			{ hardErrorFallback: true },
		);
		const event = extensionEvents[0];

		// then
		expect(extensionEvents).toHaveLength(1);
		expect(event?.lastError.length).toBeLessThanOrEqual(8_192);
		expect(event?.rejectedCandidates.length).toBeLessThanOrEqual(16);
	});
});
