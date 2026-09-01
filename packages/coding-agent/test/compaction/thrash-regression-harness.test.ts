import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import compactionExtension, { getPromptContextWindow } from "../../src/core/extensions/builtin/compaction/index.ts";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "../../src/core/extensions/index.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const WINDOWS = [200_000, 650_000, 1_000_000];
const registrations: Array<{ unregister: () => void }> = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
	agentEnd: (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void>;
	context: (event: ContextEvent, ctx: ExtensionContext) => unknown;
	beforeAgentStart: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => Promise<unknown>;
	sessionCompact: (event: unknown, ctx: ExtensionContext) => Promise<void>;
	ctx: ExtensionContext;
	applyCompaction: ReturnType<typeof vi.fn>;
	logDir: string;
}

function createHarness(contextWindow: number): Harness {
	const registration = registerFauxProvider({
		models: [
			{
				id: `thrash-${contextWindow}`,
				contextWindow,
				maxTokens: contextWindow > 500_000 ? 384_000 : contextWindow > 300_000 ? 128_000 : 100_000,
			},
		],
	});
	registrations.push(registration);
	const model = registration.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: registration.api,
		apiKey: "faux-key",
		models: registration.models.map((entry) => ({
			id: entry.id,
			name: entry.name,
			api: entry.api,
			reasoning: entry.reasoning,
			input: entry.input,
			cost: entry.cost,
			contextWindow: entry.contextWindow,
			maxTokens: entry.maxTokens,
			baseUrl: entry.baseUrl,
		})),
	});
	registration.setResponses([fauxAssistantMessage("deterministic compaction summary")]);
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "long session seed ".repeat(100) }],
		timestamp: 1,
	});
	sessionManager.appendMessage({
		...fauxAssistantMessage("seed response ".repeat(100)),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
	for (let turn = 0; turn < 24; turn++) {
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `turn ${turn} ` + "context ".repeat(1_000) }],
			timestamp: turn + 2,
		});
		sessionManager.appendMessage({
			...fauxAssistantMessage(`answer ${turn} ` + "result ".repeat(1_000)),
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
	}
	const logDir = mkdtempSync(join(tmpdir(), "senpi-thrash-harness-"));
	tempDirs.push(logDir);
	const handlers = new Map<string, (...args: never[]) => unknown>();
	const api = {
		on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
		appendEntry: vi.fn(),
		getActiveTools: () => [],
		getAllTools: () => [],
		getThinkingLevel: () => "off",
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	compactionExtension(api);
	const applyCompaction = vi.fn(async () => ({ applied: true as const, reason: "ok" as const }));
	const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 20_000 };
	let tokens = 0;
	let revision = 1;
	const ctx = {
		agentDir: logDir,
		cwd: process.cwd(),
		hasUI: false,
		mode: "tui",
		ui: { notify: vi.fn() },
		isProjectTrusted: () => true,
		sessionManager,
		modelRegistry,
		model,
		scopedModels: [],
		serviceTier: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({ tokens, contextWindow, percent: (tokens / contextWindow) * 100 }),
		getCompactionSettings: () => settings,
		compact: vi.fn(),
		getMessageRevision: () => revision,
		applyCompaction,
		beginCompaction: vi.fn(),
		endCompaction: vi.fn(),
		updateCompaction: vi.fn(),
		getSystemPrompt: () => "test system prompt",
	} as unknown as ExtensionContext;
	const agentEnd = handlers.get("agent_end") as Harness["agentEnd"];
	const context = handlers.get("context") as Harness["context"];
	const beforeAgentStart = handlers.get("before_agent_start") as Harness["beforeAgentStart"];
	const sessionCompact = handlers.get("session_compact") as Harness["sessionCompact"];
	if (!agentEnd || !context || !beforeAgentStart || !sessionCompact)
		throw new Error("compaction handlers were not registered");
	Object.defineProperty(ctx, "__setTokens", { value: (value: number) => (tokens = value) });
	Object.defineProperty(ctx, "__bumpRevision", { value: () => revision++ });
	return { agentEnd, context, beforeAgentStart, sessionCompact, ctx, applyCompaction, logDir };
}

function eventLog(logDir: string): Array<{ event: string }> {
	const path = join(logDir, "logs", "compaction.log");
	try {
		return readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function setTokens(ctx: ExtensionContext, tokens: number): void {
	(ctx as unknown as { __setTokens: (tokens: number) => void }).__setTokens(tokens);
}

function bumpRevision(ctx: ExtensionContext): void {
	(ctx as unknown as { __bumpRevision: () => void }).__bumpRevision();
}

function beforeStart(prompt = "continue the long session"): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt,
		systemPrompt: "test system prompt",
		systemPromptOptions: { cwd: process.cwd() },
	};
}

function compactEvent(): Record<string, unknown> {
	return {
		type: "session_compact",
		accepted: true,
		requestId: "thrash-apply",
		reason: "threshold",
		compactionEntry: {
			id: "compact-1",
			firstKeptEntryId: "missing",
			tokensBefore: 150_000,
			summary: "bounded summary",
		},
	};
}

describe("production-shaped compaction thrash regression", () => {
	it("keeps lifecycle counters bounded through a long multi-window session", async () => {
		for (const contextWindow of WINDOWS) {
			const harness = createHarness(contextWindow);
			const threshold = contextWindow * (contextWindow <= 512_000 ? 0.7 : 0.8);
			const lead = contextWindow <= 512_000 ? contextWindow * 0.0875 : contextWindow * 0.1;
			setTokens(harness.ctx, Math.floor(threshold));
			await harness.agentEnd({ type: "agent_end", messages: [] }, harness.ctx);
			for (let tick = 0; tick < 8; tick++) await Promise.resolve();

			// Provider/context churn is intentionally much denser than real turns. It
			// must not invalidate the one in-flight speculative lifecycle.
			for (let turn = 0; turn < 36; turn++) {
				for (let event = 0; event < 9; event++) {
					harness.context({ type: "context", messages: [] }, harness.ctx);
				}
				bumpRevision(harness.ctx);
			}
			setTokens(harness.ctx, Math.floor(threshold + lead));
			await harness.beforeAgentStart(beforeStart("apply the pending compaction"), harness.ctx);
			await harness.sessionCompact(compactEvent(), harness.ctx);

			const events = eventLog(harness.logDir);
			const count = (name: string) => events.filter((entry) => entry.event === name).length;
			const started = events.findIndex((entry) => entry.event === "speculative_started");
			const thresholdTrigger = events.findIndex((entry) => entry.event === "threshold_trigger");
			expect(started, JSON.stringify(events)).toBeGreaterThanOrEqual(0);
			expect(thresholdTrigger).toBeGreaterThan(started);
			expect(count("speculative_invalidated")).toBeLessThanOrEqual(count("speculative_started"));
			expect(count("emergency_prune")).toBe(0);
			expect(harness.applyCompaction).toHaveBeenCalled();
		}
	});

	it("pins output-adjusted prompt geometry at every production window", () => {
		expect(getPromptContextWindow(200_000, 100_000)).toBe(100_000);
		expect(getPromptContextWindow(650_000, 128_000)).toBe(522_000);
		expect(getPromptContextWindow(1_000_000, 384_000)).toBe(616_000);
	});
});
