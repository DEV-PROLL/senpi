import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";

import ttsrExtension from "../../src/core/extensions/builtin/ttsr/index.ts";
import { LEAK_ERROR_MESSAGE } from "../../src/core/extensions/builtin/ttsr/prompts.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

interface PersistedMessage {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown[];
}

interface PersistedEntry {
	type?: string;
	customType?: string;
	message?: PersistedMessage;
}

function ctrlToken(name: string): string {
	return ["<", "|", name, "|", ">"].join("");
}

function readSessionLines(harness: Harness): string[] {
	const file = harness.sessionManager.getSessionFile();
	if (file === undefined) {
		throw new Error("expected a persisted session file");
	}
	return readFileSync(file, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0);
}

function readSessionEntries(harness: Harness): PersistedEntry[] {
	const entries: PersistedEntry[] = [];
	for (const line of readSessionLines(harness)) {
		const parsed: PersistedEntry = JSON.parse(line);
		entries.push(parsed);
	}
	return entries;
}

function blockField(block: unknown, kind: "text" | "thinking"): string | undefined {
	if (typeof block !== "object" || block === null) return undefined;
	if (!("type" in block) || block.type !== kind) return undefined;
	if (kind === "thinking" && "thinking" in block && typeof block.thinking === "string") return block.thinking;
	if (kind === "text" && "text" in block && typeof block.text === "string") return block.text;
	return undefined;
}

function streamText(message: PersistedMessage | undefined, kind: "text" | "thinking"): string {
	let combined = "";
	for (const block of message?.content ?? []) {
		combined += blockField(block, kind) ?? "";
	}
	return combined;
}

describe("collapse remediation persistence", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await createHarness({ extensionFactories: [ttsrExtension], persistSession: true });
	});

	afterEach(() => {
		harness.cleanup();
	});

	it("persists only the truncated same-role replacement and discards the garbage run durably", async () => {
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(`analyzing the problem ${"!".repeat(600)} and then back to normal`)]),
			fauxAssistantMessage([fauxText("recovered answer")]),
		]);

		await harness.session.prompt("do work");

		const lines = readSessionLines(harness);
		const entries = readSessionEntries(harness);
		expect(lines.length).toBe(entries.length);
		expect(lines.length).toBe(6);

		const assistantEntries = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
		expect(assistantEntries.length).toBe(2);

		const aborted = assistantEntries[0]?.message;
		expect(aborted?.role).toBe("assistant");
		expect(aborted?.stopReason).toBe("aborted");
		const thinking = streamText(aborted, "thinking");
		expect(thinking.startsWith("analyzing the problem")).toBe(true);
		expect(thinking.length).toBeLessThan(40);
		expect(streamText(aborted, "text")).toContain("[output interrupted by stream rule]");

		for (const line of lines) {
			expect(/!{301,}/.test(line)).toBe(false);
		}

		expect(getMessageText(assistantEntries[1]?.message)).toContain("recovered answer");
	});
});

describe("leakage remediation retry", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await createHarness({
			extensionFactories: [ttsrExtension],
			persistSession: true,
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
	});

	afterEach(() => {
		harness.cleanup();
	});

	it("persists the error shell, fires exactly one bounded auto-retry, and keeps the shell in history", async () => {
		const leaked = `${ctrlToken("sep")} ${ctrlToken("sep")} ${ctrlToken("sep")}`;
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(`Thinking... ${leaked} ${ctrlToken("sep")} trailing ${"x".repeat(400)}`)]),
			fauxAssistantMessage([fauxText("clean answer")]),
		]);

		await harness.session.prompt("do work");

		expect(harness.faux.getCallLog().length).toBe(2);

		const retryStarts = harness.eventsOfType("auto_retry_start");
		expect(retryStarts.length).toBe(1);
		expect(retryStarts[0]?.attempt).toBe(1);
		expect(retryStarts[0]?.maxAttempts).toBe(3);
		expect(retryStarts[0]?.errorMessage).toBe(LEAK_ERROR_MESSAGE);

		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);

		const lines = readSessionLines(harness);
		const entries = readSessionEntries(harness);
		expect(lines.length).toBe(5);

		const assistantEntries = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
		expect(assistantEntries.length).toBe(2);
		const shelled = assistantEntries[0]?.message;
		expect(shelled?.role).toBe("assistant");
		expect(shelled?.stopReason).toBe("error");
		expect(shelled?.errorMessage).toBe(LEAK_ERROR_MESSAGE);
		expect(Array.isArray(shelled?.content) ? shelled.content : [1]).toHaveLength(0);
		expect(getMessageText(assistantEntries[1]?.message)).toContain("clean answer");
	});
});

describe("message_end fail-closed ordering", () => {
	let harness: Harness;
	let seenThinkingLengths: number[];
	let extensionErrors: string[];

	beforeEach(async () => {
		seenThinkingLengths = [];
		extensionErrors = [];
		const throwingExtension = (pi: Parameters<typeof ttsrExtension>[0]): void => {
			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;
				let thinkingLength = 0;
				for (const block of event.message.content) {
					if (block.type === "thinking") thinkingLength += block.thinking.length;
				}
				seenThinkingLengths.push(thinkingLength);
				throw new Error("downstream message_end handler boom");
			});
		};
		harness = await createHarness({
			extensionFactories: [ttsrExtension, throwingExtension],
			persistSession: true,
		});
		harness.getExtensionRunner().onError((error) => {
			if (error.event === "message_end") {
				extensionErrors.push(error.error);
			}
		});
	});

	afterEach(() => {
		harness.cleanup();
	});

	it("a throwing downstream handler sees the replacement, cannot undo it, and the throw is swallowed", async () => {
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(`analyzing the problem ${"!".repeat(600)} and then back to normal`)]),
			fauxAssistantMessage([fauxText("recovered answer")]),
		]);

		await harness.session.prompt("do work");

		expect(seenThinkingLengths.length).toBe(2);
		expect(seenThinkingLengths[0]).toBeGreaterThan(0);
		expect(seenThinkingLengths[0]).toBeLessThan(40);
		expect(extensionErrors).toEqual(["downstream message_end handler boom", "downstream message_end handler boom"]);

		const entries = readSessionEntries(harness);
		const assistantEntries = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
		expect(assistantEntries.length).toBe(2);
		const aborted = assistantEntries[0]?.message;
		expect(aborted?.role).toBe("assistant");
		expect(aborted?.stopReason).toBe("aborted");
		expect(streamText(aborted, "thinking").startsWith("analyzing the problem")).toBe(true);
		expect(streamText(aborted, "text")).toContain("[output interrupted by stream rule]");
		expect(harness.faux.getCallLog().length).toBe(2);
	});
});
