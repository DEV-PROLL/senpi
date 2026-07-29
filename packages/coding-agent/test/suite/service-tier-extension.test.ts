import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import serviceTierExtension, {
	addServiceTierToPayload,
	type ServiceTier,
} from "../../src/core/extensions/builtin/service-tier.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("service-tier builtin extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
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

	it("toggles priority tier with /fast within the current session", async () => {
		// given
		const harness = await createHarness({
			api: "openai-codex-responses",
			provider: "openai-codex",
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("fast"), fauxAssistantMessage("default")]);
		const runner = harness.getExtensionRunner();

		// when
		await harness.session.prompt("/fast");
		const priorityPayload = await runner.emitBeforeProviderRequest({ model: "gpt-5.6-sol" });

		// then
		expect(priorityPayload).toMatchObject({ service_tier: "priority" });

		// when
		await harness.session.prompt("/fast");
		const defaultPayload = await runner.emitBeforeProviderRequest({
			model: "gpt-5.6-sol",
			service_tier: "priority",
		});

		// then
		expect(defaultPayload).not.toHaveProperty("service_tier");
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
			model: "gpt-5",
			service_tier: "flex",
		};

		// when
		const result = addServiceTierToPayload("openai-responses", payload, "priority");

		// then
		expect(result).toBe(payload);
	});
});
