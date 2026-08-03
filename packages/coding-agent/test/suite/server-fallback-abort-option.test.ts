import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

async function captureStreamOptions(harness: Harness): Promise<SimpleStreamOptions[]> {
	const captured: SimpleStreamOptions[] = [];
	const inner = harness.session.agent.streamFunction;
	harness.session.agent.streamFunction = (model, context, options) => {
		captured.push(options ?? {});
		return inner(model, context, options);
	};
	harness.setResponses([fauxAssistantMessage("ok")]);
	await harness.session.prompt("hello");
	return captured;
}

describe("abortServerSideFallback reaches the provider options", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("enables the abort when the current model has a configured chain", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { fallbackChains: { "faux/faux-1": ["faux/faux-2"] } } },
		});
		harnesses.push(harness);
		const captured = await captureStreamOptions(harness);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.abortServerSideFallback).toBe(true);
	});

	it("follows the server fallback when the current model has no configured chain", async () => {
		const harness = await createHarness({ settings: { retry: { fallbackChains: {} } } });
		harnesses.push(harness);
		const captured = await captureStreamOptions(harness);
		expect(captured[0]?.abortServerSideFallback).toBe(false);
	});

	it("forwards an explicit opt-out", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					abortServerSideFallback: false,
					fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		const captured = await captureStreamOptions(harness);
		expect(captured[0]?.abortServerSideFallback).toBe(false);
	});

	it("refreshes the policy after a model switch", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { fallbackChains: { "faux/faux-1": ["faux/faux-2"] } } },
		});
		harnesses.push(harness);
		const fallbackModel = harness.getModel("faux-2");
		expect(fallbackModel).toBeDefined();
		if (!fallbackModel) return;

		await harness.session.setModel(fallbackModel);
		const captured = await captureStreamOptions(harness);

		expect(captured[0]?.abortServerSideFallback).toBe(false);
	});
});
