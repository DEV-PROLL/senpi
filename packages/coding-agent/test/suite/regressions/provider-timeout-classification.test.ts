import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_STREAM_START_TIMEOUT_MS = 90_000;

function getStreamStartTimeoutMs(options: unknown): number | undefined {
	if (!options || typeof options !== "object" || !("streamStartTimeoutMs" in options)) return undefined;
	const value = (options as { streamStartTimeoutMs?: unknown }).streamStartTimeoutMs;
	return typeof value === "number" ? value : undefined;
}

describe("provider timeout classification", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("does not apply provider timeout policy to incidental extension timeout text", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
		harness.agent.streamStartTimeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "extension timed out" }),
			fauxAssistantMessage("generic retry recovered"),
		]);

		await harness.session.prompt("first request");

		expect(harness.faux.getCallLog().map((call) => call.options?.timeoutMs)).toEqual([
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
		]);
		expect(harness.faux.getCallLog().map((call) => getStreamStartTimeoutMs(call.options))).toEqual([
			DEFAULT_STREAM_START_TIMEOUT_MS,
			DEFAULT_STREAM_START_TIMEOUT_MS,
		]);
	});

	it("does not retry unrelated aborted timeout text", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Command timed out after 30000ms" }),
			fauxAssistantMessage("must not run"),
		]);

		await harness.session.prompt("first request");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});
});
