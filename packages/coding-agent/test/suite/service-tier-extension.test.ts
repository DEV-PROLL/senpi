import { afterEach, describe, expect, it, vi } from "vitest";
import serviceTierExtension, {
	addServiceTierToPayload,
	type ServiceTier,
} from "../../src/core/extensions/builtin/service-tier.ts";
import { createHarness, type Harness } from "./harness.ts";

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const BASE_MODEL_ID = "gpt-5.6-sol";
const FAST_MODEL_ID = `${BASE_MODEL_ID}-fast`;

describe("service-tier builtin extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		vi.restoreAllMocks();
	});

	it("leaves payload unchanged when service tier is unset", () => {
		// given
		const payload = {
			model: "gpt-5",
		};

		// when
		const result = addServiceTierToPayload("openai-responses", payload, undefined);

		// then
		expect(result).toBe(payload);
	});

	it("injects service_tier for openai responses payloads when configured", () => {
		// given
		const payload = {
			model: "gpt-5",
		};

		// when
		const result = addServiceTierToPayload("openai-responses", payload, "priority") as {
			service_tier?: ServiceTier;
		};

		// then
		expect(result.service_tier).toBe("priority");
	});

	it("resets a fast model on session_start, then toggles the catalog variant within the session", async () => {
		// given
		const harness = await createHarness({
			api: CODEX_API,
			provider: CODEX_PROVIDER,
			models: [{ id: FAST_MODEL_ID }, { id: BASE_MODEL_ID }],
			upstreamModelId: BASE_MODEL_ID,
			serviceTier: "priority",
			settings: {
				defaultProvider: CODEX_PROVIDER,
				defaultModel: BASE_MODEL_ID,
			},
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		expect(harness.session.model?.id).toBe(FAST_MODEL_ID);

		// when
		await harness.session.bindExtensions({});

		// then
		expect(harness.session.model?.id).toBe(BASE_MODEL_ID);
		expect(harness.session.serviceTier).toBeUndefined();
		expect(harness.settingsManager.getDefaultProvider()).toBe(CODEX_PROVIDER);
		expect(harness.settingsManager.getDefaultModel()).toBe(BASE_MODEL_ID);

		// when
		await harness.session.prompt("/fast");

		// then
		expect(harness.session.model?.id).toBe(FAST_MODEL_ID);
		expect(harness.session.serviceTier).toBe("priority");
		const fastModel = harness.session.model;
		expect(fastModel).toBeDefined();
		const upstreamModelId = harness.modelRegistry.getUpstreamModelId(fastModel!) ?? fastModel!.id;
		const priorityPayload = await runner.emitBeforeProviderRequest({ model: upstreamModelId });
		expect(priorityPayload).toEqual({
			model: BASE_MODEL_ID,
			service_tier: "priority",
		});

		// when
		await harness.session.prompt("/fast");

		// then
		expect(harness.session.model?.id).toBe(BASE_MODEL_ID);
		expect(harness.session.serviceTier).toBeUndefined();
		expect(harness.settingsManager.getDefaultProvider()).toBe(CODEX_PROVIDER);
		expect(harness.settingsManager.getDefaultModel()).toBe(BASE_MODEL_ID);
		const defaultPayload = { model: BASE_MODEL_ID };
		expect(await runner.emitBeforeProviderRequest(defaultPayload)).toBe(defaultPayload);
	});

	it("is a clear no-op for non-Codex providers", async () => {
		// given
		const harness = await createHarness({
			api: "anthropic-messages",
			provider: "anthropic",
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		const notify = vi.spyOn(runner.getUIContext(), "notify");
		const initialModel = harness.session.model;

		// when
		await harness.session.prompt("/fast");

		// then
		expect(harness.session.model).toBe(initialModel);
		expect(notify).toHaveBeenCalledWith("Fast mode is only available for OpenAI Codex models.", "warning");
	});

	it("is a clear no-op when the Codex model has no compatible fast variant", async () => {
		// given
		const harness = await createHarness({
			api: CODEX_API,
			provider: CODEX_PROVIDER,
			models: [{ id: BASE_MODEL_ID }, { id: FAST_MODEL_ID }],
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		const notify = vi.spyOn(runner.getUIContext(), "notify");
		const initialModel = harness.session.model;

		// when
		await harness.session.prompt("/fast");

		// then
		expect(harness.session.model).toBe(initialModel);
		expect(notify).toHaveBeenCalledWith(
			`Fast mode is not supported for ${CODEX_PROVIDER}/${BASE_MODEL_ID}.`,
			"warning",
		);
	});

	it("leaves incompatible api payloads unchanged", () => {
		// given
		const payload = {
			model: "claude-sonnet-4-5",
		};

		// when
		const result = addServiceTierToPayload("anthropic-messages", payload, "priority");

		// then
		expect(result).toBe(payload);
	});

	it("preserves explicit service_tier values already present on the payload", () => {
		// given
		const payload = {
			model: BASE_MODEL_ID,
			service_tier: "flex",
		};

		// when
		const result = addServiceTierToPayload(CODEX_API, payload, "priority");

		// then
		expect(result).toBe(payload);
	});
});
