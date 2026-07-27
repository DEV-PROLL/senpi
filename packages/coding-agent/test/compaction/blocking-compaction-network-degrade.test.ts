import { fauxAssistantMessage, registerFauxProvider, type UserMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
} from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createInMemoryExtensionSessionSettings } from "../helpers/extension-session-settings.ts";

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function userMessage(text: string, timestamp: number): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function createBeforeAgentStartHandler(): ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> {
	let beforeAgentStartHandler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> | undefined;
	const api = {
		on: (event: string, handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>) => {
			if (event === "before_agent_start") beforeAgentStartHandler = handler;
		},
	} as ExtensionAPI;
	compactionExtension(api);
	expect(beforeAgentStartHandler).toBeDefined();
	return beforeAgentStartHandler as ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
}

interface BlockingHarness {
	ctx: ExtensionContext;
	endCompaction: ReturnType<typeof vi.fn>;
	registration: ReturnType<typeof registerFauxProvider>;
}

function createBlockingContext(options: { usageTokens: number; withAuth?: boolean }): BlockingHarness {
	const registration = registerFauxProvider();
	registrations.push(registration);
	const model = registration.getModel();
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage(userMessage("Summarize old context", 1));
	sessionManager.appendMessage({
		...fauxAssistantMessage("Old assistant context ".repeat(6_000), { timestamp: 2 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 30_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	sessionManager.appendMessage(userMessage("Keep latest request", 3));
	const modelRegistry = Object.create(null) as ExtensionContext["modelRegistry"];
	modelRegistry.getApiKeyAndHeaders =
		options.withAuth === false
			? async () => ({ ok: false, error: "no API key configured" })
			: async () => ({ ok: true, apiKey: "test-key" });
	const endCompaction = vi.fn();
	const ctx = {
		hasUI: false,
		mode: "print",
		ui: Object.create(null) as ExtensionContext["ui"],
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager,
		modelRegistry,
		model,
		serviceTier: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({
			tokens: options.usageTokens,
			contextWindow: 10_000,
			percent: (options.usageTokens / 10_000) * 100,
		}),
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 2_000 }),
		getLookAtSettings: () => ({ enabled: true, models: undefined }),
		getImageSettings: () => ({ autoResize: true, blockImages: false }),
		sessionSettings: createInMemoryExtensionSessionSettings(),
		compact: vi.fn(),
		getMessageRevision: () => 1,
		applyCompaction: vi.fn(async () => ({ applied: true as const, reason: "ok" as const })),
		beginCompaction: () => undefined,
		endCompaction,
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
	return { ctx, endCompaction, registration };
}

function createEvent(): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "continue",
		systemPrompt: "system",
		systemPromptOptions: Object.create(null) as BeforeAgentStartEvent["systemPromptOptions"],
	};
}

function connectionErrorResponse() {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." });
}

describe("blocking compaction network-failure degradation", () => {
	describe("Given the provider connection drops during emergency blocking compaction", () => {
		it("Then before_agent_start degrades cleanly instead of erroring the turn", async () => {
			// Given: usage at the hard limit forces blocking compaction, and the
			// summarization request fails with a transient connection error.
			const handler = createBeforeAgentStartHandler();
			const harness = createBlockingContext({ usageTokens: 9_950 });
			harness.registration.setResponses([connectionErrorResponse()]);

			// When / Then: the handler resolves (no extension-error stack surface)…
			await expect(handler(createEvent(), harness.ctx)).resolves.toBeUndefined();

			// …and the single clean surface is compaction_end's errorMessage.
			expect(harness.endCompaction).toHaveBeenCalledWith(
				expect.objectContaining({ errorMessage: "Compaction failed: Connection error." }),
			);
		});
	});

	describe("Given repeated transient blocking-compaction failures", () => {
		it("Then the circuit breaker skips further proactive attempts during cooldown", async () => {
			// Given: usage above the proactive threshold (45% of 10k) but below the
			// hard limit, so the proactive blocking route is taken each prompt.
			const handler = createBeforeAgentStartHandler();
			const harness = createBlockingContext({ usageTokens: 6_000 });
			harness.registration.setResponses([
				connectionErrorResponse(),
				connectionErrorResponse(),
				connectionErrorResponse(),
			]);

			// When: three consecutive prompts fail on connection errors.
			for (let attempt = 0; attempt < 3; attempt++) {
				await expect(handler(createEvent(), harness.ctx)).resolves.toBeUndefined();
			}
			const callsAfterTrip = harness.registration.state.callCount;
			await expect(handler(createEvent(), harness.ctx)).resolves.toBeUndefined();

			// Then: the tripped breaker stops the fourth prompt from paying for
			// another doomed summarization request.
			expect(callsAfterTrip).toBe(3);
			expect(harness.registration.state.callCount).toBe(callsAfterTrip);
		});
	});

	describe("Given a non-transient summarization failure", () => {
		it("Then the failure still surfaces loudly as an extension error", async () => {
			// Given: a deterministic provider rejection that retrying cannot fix.
			const handler = createBeforeAgentStartHandler();
			const harness = createBlockingContext({ usageTokens: 9_950 });
			harness.registration.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "request blocked by provider policy",
				}),
			]);

			// When / Then: unchanged behavior — real bugs and policy rejections
			// keep propagating so they stay visible.
			await expect(handler(createEvent(), harness.ctx)).rejects.toThrow("request blocked by provider policy");
		});
	});

	describe("Given summarization credentials are unavailable", () => {
		it("Then blocking compaction degrades silently as before", async () => {
			// Given
			const handler = createBeforeAgentStartHandler();
			const harness = createBlockingContext({ usageTokens: 9_950, withAuth: false });
			harness.registration.setResponses([fauxAssistantMessage("never reached")]);

			// When / Then: SummaryGenerationError keeps its degrade-to-unavailable
			// contract, with no error message on the compaction feedback.
			await expect(handler(createEvent(), harness.ctx)).resolves.toBeUndefined();
			const callsWithError = harness.endCompaction.mock.calls.filter(
				(call) => typeof call[0]?.errorMessage === "string",
			);
			expect(callsWithError).toHaveLength(0);
		});
	});
});
