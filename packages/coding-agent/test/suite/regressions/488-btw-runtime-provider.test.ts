import { createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import btwExtension from "../../../src/core/extensions/builtin/btw/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const PROVIDER_ID = "runtime-only";
const API_ID = "runtime-only-api";

describe("issue #488: /btw with a runtime-registered provider", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("dispatches the side query through the model runtime", async () => {
		// Given a provider available only through Senpi's ModelRuntime.
		harness = await createHarness({ extensionFactories: [btwExtension] });
		const runtime = harness.modelRegistry.modelRuntime;
		const model: Model<typeof API_ID> = {
			...harness.getModel(),
			api: API_ID,
			provider: PROVIDER_ID,
			id: "runtime-model",
			name: "Runtime-only model",
			baseUrl: PROVIDER_ID,
		};
		let sideQueryCalls = 0;
		await runtime.registerProvider(PROVIDER_ID, {
			api: API_ID,
			apiKey: "runtime-key",
			baseUrl: PROVIDER_ID,
			models: [model],
			streamSimple: () => {
				sideQueryCalls += 1;
				const message = fauxAssistantMessage("runtime side answer");
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "text_delta", contentIndex: 0, delta: "runtime side answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
				return stream;
			},
		});
		const registeredModel = runtime.getModel(PROVIDER_ID, model.id);
		if (!registeredModel) throw new Error("runtime-only model was not registered");
		await harness.session.setModel(registeredModel);

		// When the user asks a side question.
		await harness.session.prompt("/btw what did we discuss?");

		// Then the runtime provider handles the request instead of compat rejecting its API id.
		expect(sideQueryCalls).toBe(1);
	});
});
