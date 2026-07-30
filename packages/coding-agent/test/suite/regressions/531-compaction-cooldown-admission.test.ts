import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import type { InlineExtension } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

function breakerCancelledCompaction(): InlineExtension {
	return ((pi: ExtensionAPI) => {
		pi.on("session_before_compact", () => ({
			cancel: true,
			rejectionCause: "circuit-breaker",
			reason: "compaction circuit breaker cooling down (60s left)",
		}));
	}) as InlineExtension;
}

function genericallyCancelledCompaction(): InlineExtension {
	return ((pi: ExtensionAPI) => {
		pi.on("session_before_compact", () => ({
			cancel: true,
			rejectionCause: "cancelled-by-extension",
			reason: "extension refused",
		}));
	}) as InlineExtension;
}

async function createOverThresholdHarness(extension: InlineExtension): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-large", contextWindow: 20_000, maxTokens: 4_096 }],
		settings: { compaction: { reserveTokens: 1_000 } },
		extensionFactories: [extension],
	});
	harnesses.push(harness);
	const timestamp = Date.now() - 1_000;
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "work through the todo list" }],
		timestamp: timestamp - 1,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("progress note ".concat("x".repeat(80_000)), { timestamp }),
		usage: {
			input: 19_500,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 19_500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return harness;
}

describe("issue #531: compaction cooldown must not brick prompt admission", () => {
	it("lets the turn proceed without compaction when the breaker cancelled it", async () => {
		const harness = await createOverThresholdHarness(breakerCancelledCompaction());
		harness.setResponses([fauxAssistantMessage("continued fine")]);

		await harness.session.prompt("next todo item");

		const texts = harness.session.agent.state.messages
			.filter((message) => message.role === "assistant")
			.map((message) => JSON.stringify(message));
		expect(texts.some((text) => text.includes("continued fine"))).toBe(true);
	});

	it("keeps failing closed when compaction is cancelled for a non-breaker reason", async () => {
		const harness = await createOverThresholdHarness(genericallyCancelledCompaction());
		harness.setResponses([fauxAssistantMessage("should never be sent")]);

		await expect(harness.session.prompt("next todo item")).rejects.toThrow(
			"Context remains above the compaction threshold because compaction did not complete",
		);
		expect(harness.faux.getCallLog()).toEqual([]);
	});
});
