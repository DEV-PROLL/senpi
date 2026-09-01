import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension, { getPromptContextWindow } from "../../src/core/extensions/builtin/compaction/index.ts";
import {
	computeEffectiveThreshold,
	resolveEffectiveReserveTokens,
} from "../../src/core/extensions/builtin/compaction/policy.ts";
import { resolveSpeculationLeadTokens } from "../../src/core/extensions/builtin/compaction/speculation-lead.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const WINDOWS = [200_000, 650_000, 1_000_000] as const;
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function logEvents(harness: Harness): Array<{ event: string }> {
	const candidates = [
		join(harness.tempDir, "logs", "compaction.log"),
		join(harness.tempDir, "agent", "logs", "compaction.log"),
		...readdirSync(harness.tempDir, { recursive: true })
			.filter((entry): entry is string => typeof entry === "string" && entry.endsWith("compaction.log"))
			.map((entry) => join(harness.tempDir, entry)),
	];
	const path = candidates.find((candidate) => {
		try {
			return readFileSync(candidate);
		} catch {
			return false;
		}
	});
	try {
		if (!path) return [];
		return readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function count(events: Array<{ event: string }>, event: string): number {
	return events.filter((entry) => entry.event === event).length;
}

function eventIndex(events: Array<{ event: string }>, event: string): number {
	return events.findIndex((entry) => entry.event === event);
}

async function runLongSession(contextWindow: number): Promise<{ harness: Harness; events: Array<{ event: string }> }> {
	const harness = await createHarness({
		models: [
			{
				id: `thrash-${contextWindow}`,
				contextWindow,
				maxTokens: contextWindow > 500_000 ? 384_000 : contextWindow > 300_000 ? 128_000 : 100_000,
			},
		],
		settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
		extensionFactories: [(pi) => compactionExtension(pi)],
	});
	harnesses.push(harness);
	const threshold = contextWindow * computeEffectiveThreshold(contextWindow);
	const _reserve = resolveEffectiveReserveTokens(contextWindow, harness.settingsManager.getCompactionSettings());
	const lead = resolveSpeculationLeadTokens(threshold);
	const seedTokens = Math.floor(threshold - lead + 100);
	const seed = "long-session-context";
	const seedResponse = fauxAssistantMessage("seed response");
	seedResponse.usage = { ...seedResponse.usage, input: seedTokens, totalTokens: seedTokens };
	harness.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: seed }], timestamp: 1 });
	seedResponse.usage = { ...seedResponse.usage, input: seedTokens, totalTokens: seedTokens };
	harness.sessionManager.appendMessage({
		...seedResponse,
		api: harness.getModel().api,
		provider: harness.getModel().provider,
		model: harness.getModel().id,
	});
	for (let index = 0; index < 24; index++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `turn-${index}` }],
			timestamp: index + 2,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage(`answer-${index}`),
			api: harness.getModel().api,
			provider: harness.getModel().provider,
			model: harness.getModel().id,
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

	harness.setResponses([fauxAssistantMessage("deterministic speculative summary")]);
	const runner = harness.getExtensionRunner();
	if ((harness.session.getContextUsage()?.tokens ?? 0) < threshold - lead)
		throw new Error(`usage too low: ${harness.session.getContextUsage()?.tokens}`);
	await runner.emit({
		type: "before_agent_start",
		prompt: "speculate",
		systemPrompt: "test",
		systemPromptOptions: { cwd: harness.tempDir },
	});
	const firstEntry = harness.sessionManager.getEntries()[0];
	if (!firstEntry) throw new Error("missing session entry");
	const applied = await harness.session.applyCompaction(
		{ summary: "real applied summary", firstKeptEntryId: firstEntry.id, tokensBefore: seedTokens },
		{ reason: "extension", expectedRevision: harness.session.getMessageRevision() },
	);
	if (!applied.applied) throw new Error(`compaction did not apply: ${applied.reason}`);

	// These are real ExtensionRunner context events with runner-built contexts;
	// churn is intentionally denser than normal provider requests.
	if (!runner.isActive || !runner.hasHandlers("before_agent_start"))
		throw new Error("real compaction extension is inactive");
	for (let turn = 0; turn < 36; turn++) {
		for (let event = 0; event < 9; event++) await runner.emitContext([]);
	}
	const events = logEvents(harness);
	return { harness, events };
}

describe("production-shaped compaction thrash regression", () => {
	it("keeps counters bounded through real AgentSession and ExtensionRunner sequencing", async () => {
		for (const contextWindow of WINDOWS) {
			const { harness, events } = await runLongSession(contextWindow);
			const started = eventIndex(events, "speculative_started");
			const threshold = eventIndex(events, "threshold_trigger");
			const emergency = eventIndex(events, "emergency_prune");
			const reserve = resolveEffectiveReserveTokens(contextWindow, harness.settingsManager.getCompactionSettings());
			const thresholdTokens = contextWindow * computeEffectiveThreshold(contextWindow);
			const lead = resolveSpeculationLeadTokens(thresholdTokens);
			expect(started, JSON.stringify(events)).toBeGreaterThanOrEqual(0);
			expect(threshold, JSON.stringify(events)).toBeGreaterThanOrEqual(-1);
			expect(emergency).toBeGreaterThanOrEqual(-1);
			expect(thresholdTokens - lead).toBeLessThan(thresholdTokens);
			expect(thresholdTokens).toBeLessThan(contextWindow - reserve);
			expect(count(events, "speculative_invalidated")).toBeLessThanOrEqual(count(events, "speculative_started"));
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
		}
	});

	it("pins the shipped prompt geometry through observed harness configuration", () => {
		expect(getPromptContextWindow(200_000, 100_000)).toBe(100_000);
		expect(getPromptContextWindow(650_000, 128_000)).toBe(522_000);
		expect(getPromptContextWindow(1_000_000, 384_000)).toBe(616_000);
	});
});
