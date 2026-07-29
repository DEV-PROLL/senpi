import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

/**
 * Emitted by the agent loop when a provider stream delivers zero events for the
 * whole idle budget (packages/agent StreamIdleTimeoutError). Every retry of such
 * a stall replays the identical payload and, against a hung provider/gateway,
 * silently burns the full idle budget again: (1 + maxRetries) * httpIdleTimeoutMs
 * (~20 minutes at defaults) before the fallback chain is ever consulted.
 * Captured in the donated session 019fa8da-43ad-70b7-b01b-8f34f4d907f2 (records
 * 1906/1919): the user experienced this as a permanently wedged session.
 */
const STALL_ERROR = "Idle timeout waiting for provider stream after 300000ms";

describe("retry fallback stall escalation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("escalates to the fallback chain on the second consecutive provider-stream stall", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: STALL_ERROR }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: STALL_ERROR }),
			fauxAssistantMessage("fallback answer"),
		]);

		await harness.session.prompt("hello");

		// One same-model retry probe after the first stall, then the second
		// consecutive stall switches to the chain instead of burning the
		// remaining same-model budget on identical replays.
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, chainKey: primary, reason: "transient" },
		]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([1, 0]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("ends the retry loop on the second consecutive stall when no fallback chain exists", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: STALL_ERROR }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: STALL_ERROR }),
			fauxAssistantMessage("must never be requested"),
		]);

		await harness.session.prompt("hello");

		// The second consecutive stall surrenders instead of replaying the same
		// doomed payload for the rest of the budget.
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([false]);
	});

	it("keeps the full same-model retry budget for non-consecutive stalls", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: STALL_ERROR }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: STALL_ERROR }),
			fauxAssistantMessage("primary recovered"),
		]);

		await harness.session.prompt("hello");

		// A fast non-stall failure between stalls proves the provider is
		// reachable again; the stall streak resets and the same-model budget
		// applies unchanged (matches the observed 2026-07-21 network-blip
		// recovery where cheap same-model probes healed the session).
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([1, 2, 4]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(harness.faux.state.callCount).toBe(4);
	});
});
