import { createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const PROVIDER_ID = "runtime-only-compaction";
const API_ID = "runtime-only-compaction-api";
const SUMMARY = "runtime summary";

describe("issue #543: compaction with a runtime-registered provider", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("dispatches the summarization request through the model runtime", async () => {
		// Given a provider whose api id exists only in Senpi's ModelRuntime, never in compat's registry.
		harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [compactionExtension],
		});
		const runtime = harness.modelRegistry.modelRuntime;
		const model: Model<typeof API_ID> = {
			...harness.getModel(),
			api: API_ID,
			provider: PROVIDER_ID,
			id: "runtime-model",
			name: "Runtime-only model",
			baseUrl: PROVIDER_ID,
			contextWindow: 32_000,
		};
		let summarizationCalls = 0;
		await runtime.registerProvider(PROVIDER_ID, {
			api: API_ID,
			apiKey: "runtime-key",
			baseUrl: PROVIDER_ID,
			models: [model],
			streamSimple: () => {
				summarizationCalls += 1;
				const message = fauxAssistantMessage(SUMMARY);
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			},
		});
		const registeredModel = runtime.getModel(PROVIDER_ID, model.id);
		if (!registeredModel) throw new Error("runtime-only model was not registered");
		await harness.session.bindExtensions({});
		await harness.session.setModel(registeredModel);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: 1,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("assistant response to compact"),
			api: registeredModel.api,
			provider: registeredModel.provider,
			model: registeredModel.id,
			timestamp: 2,
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to keep" }],
			timestamp: 3,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		// When the session compacts.
		const result = await harness.session.compact();

		// Then the runtime provider produced the summary instead of compat rejecting its api id.
		expect(summarizationCalls).toBe(1);
		expect(result.summary).toContain(SUMMARY);
	});
});
