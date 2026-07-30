import { describe, expect, it } from "vitest";
import { StreamDurationBudgetError, StreamIdleTimeoutError } from "../../src/core/compaction/stream-watchdog.ts";
import { SummaryRequestError } from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { isTransientSummarizationFailure } from "../../src/core/extensions/builtin/compaction/transient-failure.ts";

/**
 * A summarization that blows its wall-clock budget is an infrastructure-slowness
 * outcome, exactly like a stalled stream: it must degrade through the compaction
 * failure path (compaction_end + circuit breaker) instead of escaping to the
 * extension runner as a raw stack on top of the message the user already saw.
 */
describe("isTransientSummarizationFailure", () => {
	it("treats a wall-clock budget trip as transient", () => {
		const error = new StreamDurationBudgetError(120_000);
		expect(isTransientSummarizationFailure(error, error.message)).toBe(true);
	});

	it("treats a stalled-stream idle timeout as transient", () => {
		const error = new StreamIdleTimeoutError(300_000);
		expect(isTransientSummarizationFailure(error, error.message)).toBe(true);
	});

	it("keeps provider-classified request errors on their own verdict", () => {
		const loud = new SummaryRequestError("refusal that mentions timeout", false);
		expect(isTransientSummarizationFailure(loud, loud.message)).toBe(false);
		const transient = new SummaryRequestError("overloaded", true);
		expect(isTransientSummarizationFailure(transient, transient.message)).toBe(true);
	});

	it("recognizes the exact upstream truncated-stream code", () => {
		const error = new SummaryRequestError(
			"upstream_stream_truncated: Responses stream ended before a terminal event",
			false,
		);
		expect(isTransientSummarizationFailure(error, error.message)).toBe(true);
	});

	it("falls back to the message classifier for bare transport throws", () => {
		const network = new Error("fetch failed");
		expect(isTransientSummarizationFailure(network, network.message)).toBe(true);
		const bug = new TypeError("cannot read properties of undefined");
		expect(isTransientSummarizationFailure(bug, bug.message)).toBe(false);
	});
});
