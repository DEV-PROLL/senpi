import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxThinking, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import ttsrExtension from "../../src/core/extensions/builtin/ttsr/index.ts";
import { LEAK_ERROR_MESSAGE } from "../../src/core/extensions/builtin/ttsr/prompts.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

interface PersistedMessage {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown[];
}

interface PersistedEntry {
	type?: string;
	message?: PersistedMessage;
}

function ctrlToken(name: string): string {
	return ["<", "|", name, "|", ">"].join("");
}

function leakStream(): string {
	const leaked = `${ctrlToken("sep")} ${ctrlToken("sep")} ${ctrlToken("sep")}`;
	return `Thinking... ${leaked} ${ctrlToken("sep")} trailing ${"x".repeat(400)}`;
}

function readSessionEntries(harness: Harness): PersistedEntry[] {
	const file = harness.sessionManager.getSessionFile();
	if (file === undefined) {
		throw new Error("expected a persisted session file");
	}
	const entries: PersistedEntry[] = [];
	for (const line of readFileSync(file, "utf-8").split("\n")) {
		if (line.trim().length === 0) continue;
		const parsed: PersistedEntry = JSON.parse(line);
		entries.push(parsed);
	}
	return entries;
}

describe("leakage error-shell classifier pin", () => {
	it("is retryable per the real isRetryableAssistantError classifier", () => {
		const shell = fauxAssistantMessage([], { stopReason: "error", errorMessage: LEAK_ERROR_MESSAGE });
		expect(shell.role).toBe("assistant");
		expect(isRetryableAssistantError(shell)).toBe(true);
	});

	it("does not classify the aborted collapse variant as retryable", () => {
		const aborted = fauxAssistantMessage([], { stopReason: "aborted" });
		expect(isRetryableAssistantError(aborted)).toBe(false);
	});
});

describe("bounded retry exhaustion for repeated leakage", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await createHarness({
			extensionFactories: [ttsrExtension],
			persistSession: true,
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
	});

	afterEach(() => {
		harness.cleanup();
	});

	it("surfaces failure after the retry budget with no further provider calls and no hang", async () => {
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(leakStream())]),
			fauxAssistantMessage([fauxThinking(leakStream())]),
			fauxAssistantMessage([fauxThinking(leakStream())]),
		]);

		await harness.session.prompt("do work");

		expect(harness.faux.getCallLog().length).toBe(3);

		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 2]);

		const retryEnds = harness.eventsOfType("auto_retry_end");
		expect(retryEnds.length).toBe(1);
		expect(retryEnds[0]?.success).toBe(false);
		expect(retryEnds[0]?.attempt).toBe(2);
		expect(retryEnds[0]?.finalError).toBe(LEAK_ERROR_MESSAGE);

		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, true, false]);

		const entries = readSessionEntries(harness);
		const shells = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
		expect(shells.length).toBe(3);
		for (const shell of shells) {
			expect(shell.message?.stopReason).toBe("error");
			expect(shell.message?.errorMessage).toBe(LEAK_ERROR_MESSAGE);
			expect(Array.isArray(shell.message?.content) ? shell.message.content : [1]).toHaveLength(0);
		}

		expect(harness.session.isRetrying).toBe(false);
	});
});
