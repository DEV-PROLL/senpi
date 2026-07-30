import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { prepareCompaction } from "../../src/core/compaction/index.ts";
import { StreamDurationBudgetError } from "../../src/core/compaction/stream-watchdog.ts";
import {
	classifyRequiredCompactionFallbackFailure,
	createRequiredCompactionFallback,
} from "../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";
import { createBlockingContext, createCompactionHandlers } from "../helpers/blocking-compaction-harness.ts";

describe("required compaction deterministic fallback", () => {
	it("returns one durable fallback after an upstream truncated summary stream", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 9_900 });
		harness.registration.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "upstream_stream_truncated: Responses stream ended before a terminal event",
			}),
		]);
		const branchEntries = harness.ctx.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		expect(preparation).toBeDefined();

		const result = await handlers.sessionBeforeCompact(
			{
				type: "session_before_compact",
				reason: "threshold",
				willRetry: false,
				requestId: "required-fallback",
				preparation: preparation!,
				branchEntries,
				signal: new AbortController().signal,
			},
			harness.ctx,
		);

		expect(result).not.toHaveProperty("cancel");
		expect(result?.compaction).toMatchObject({
			firstKeptEntryId: "",
			tokensBefore: preparation?.tokensBefore,
			details: {
				schema: "senpi.compaction.deterministic-fallback.v1",
				origin: "required-compaction-recovery",
				failureKind: "upstream-stream-truncated",
				retainedSuffix: "none",
			},
		});
		expect(result?.compaction?.summary).toContain("Deterministic compaction recovery checkpoint");
		expect(harness.registration.getCallLog()).toHaveLength(1);
	});

	it("does not replace history for a manual compaction failure", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 9_900 });
		harness.registration.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "upstream_stream_truncated: Responses stream ended before a terminal event",
			}),
		]);
		const branchEntries = harness.ctx.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		expect(preparation).toBeDefined();

		const result = await handlers.sessionBeforeCompact(
			{
				type: "session_before_compact",
				reason: "manual",
				willRetry: false,
				requestId: "manual-no-fallback",
				preparation: preparation!,
				branchEntries,
				signal: new AbortController().signal,
			},
			harness.ctx,
		);

		expect(result).toMatchObject({ cancel: true });
		expect(result).not.toHaveProperty("compaction");
	});

	it("classifies a duration watchdog without sleeping", () => {
		expect(
			classifyRequiredCompactionFallbackFailure(
				new StreamDurationBudgetError(120_000),
				"Summarization stream exceeded its 120000ms wall-clock budget",
			),
		).toBe("summarization-timeout");
	});

	it("bounds inherited summary text and persists recovery metadata", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const preparation = prepareCompaction(
			harness.ctx.sessionManager.getBranch(),
			harness.ctx.getCompactionSettings(),
			true,
		);
		expect(preparation).toBeDefined();
		const result = createRequiredCompactionFallback(
			{ ...preparation!, previousSummary: "진행상황 ".repeat(10_000) },
			10_000,
			"summarization-timeout",
			{
				taskIntent: "Finish the current repair",
				todoSnapshot: { items: ["verify recovery"] },
				checkpoint: { files: ["agent-session.ts"] },
			},
		);

		expect(Buffer.byteLength(result.summary)).toBeLessThanOrEqual(4_000);
		expect(result.summary).not.toContain("\uFFFD");
		expect(result.details).toMatchObject({
			taskIntent: "Finish the current repair",
			todoSnapshot: { items: ["verify recovery"] },
			checkpoint: { files: ["agent-session.ts"] },
		});
	});
});
