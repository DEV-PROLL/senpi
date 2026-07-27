import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

const retrySettings: Partial<Settings> = { retry: { enabled: true, maxRetries: 3, baseDelayMs: 500 } };
function overloadedError() {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
}

async function waitForRetry(harness: Harness, maxPolls = 100): Promise<boolean> {
	for (let i = 0; i < maxPolls; i++) {
		await new Promise((r) => setImmediate(r));
		if (harness.session.retryAttempt > 0) return true;
	}
	return false;
}

describe("AgentSession.abort() emits session_abort in the gap case", () => {
	it("emits session_abort when aborting during retry backoff (not streaming)", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: retrySettings,
			extensionFactories: [],
		});
		harnesses.push(harness);
		harness.setResponses([overloadedError()]);
		const promptPromise = harness.session.prompt("trigger error then retry");
		expect(await waitForRetry(harness)).toBe(true);
		await harness.session.abort();
		await promptPromise.catch(() => undefined);
		const abortEvents = harness.eventsOfType("session_abort");
		expect(abortEvents.length).toBeGreaterThan(0);
	});

	it("does not emit session_abort on a purely-idle abort (nothing in flight)", async () => {
		const harness = await createHarness({ persistSession: true, extensionFactories: [] });
		harnesses.push(harness);
		await harness.session.abort();
		expect(harness.eventsOfType("session_abort")).toHaveLength(0);
	});

	it("does not emit session_abort on a mid-run abort (agent_end owns that)", async () => {
		const harness = await createHarness({ persistSession: true, extensionFactories: [] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("streaming ".repeat(2000))]);
		const promptPromise = harness.session.prompt("start streaming");
		await new Promise((r) => setImmediate(r));
		await harness.session.abort();
		await promptPromise.catch(() => undefined);
		expect(harness.eventsOfType("session_abort")).toHaveLength(0);
	});
});
