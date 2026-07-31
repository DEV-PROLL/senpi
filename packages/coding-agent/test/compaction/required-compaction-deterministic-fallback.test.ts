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
	it("cancels when the prepared suffix cannot fit without dropping the latest request", async () => {
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

		expect(result).toMatchObject({ cancel: true });
		expect(result).not.toHaveProperty("compaction");
		expect(JSON.stringify(harness.sessionManager.buildSessionContext().messages)).toContain("Keep latest request");
		expect(harness.registration.getCallLog()).toHaveLength(1);
	});

	it("does not recover manual, aborted, or unrelated failures", async () => {
		for (const testCase of [
			{ reason: "manual" as const, message: "upstream_stream_truncated", aborted: false },
			{ reason: "threshold" as const, message: "upstream_stream_truncated", aborted: true },
			{ reason: "threshold" as const, message: "unrelated provider refusal", aborted: false },
		]) {
			const handlers = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_900 });
			harness.registration.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: testCase.message }),
			]);
			const branchEntries = harness.ctx.sessionManager.getBranch();
			const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
			const controller = new AbortController();
			if (testCase.aborted) controller.abort();
			const result = await handlers.sessionBeforeCompact(
				{
					type: "session_before_compact",
					reason: testCase.reason,
					willRetry: false,
					requestId: `fail-closed-${testCase.reason}-${testCase.aborted}`,
					preparation: preparation!,
					branchEntries,
					signal: controller.signal,
				},
				harness.ctx,
			);
			expect(result).toMatchObject({ cancel: true });
			expect(result).not.toHaveProperty("compaction");
		}
	});

	it("classifies a duration watchdog without sleeping", () => {
		expect(
			classifyRequiredCompactionFallbackFailure(
				new StreamDurationBudgetError(120_000),
				"Summarization stream exceeded its 120000ms wall-clock budget",
			),
		).toBe("summarization-timeout");
	});

	it("requires a real retained suffix, preserves metadata, and uses UTF-8-safe bounds", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const branchEntries = harness.ctx.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true);
		expect(preparation).toBeDefined();
		expect(
			createRequiredCompactionFallback(
				{ ...preparation!, firstKeptEntryId: "" },
				100_000,
				"summarization-timeout",
				{},
				branchEntries,
			),
		).toBeUndefined();

		const result = createRequiredCompactionFallback(
			{
				...preparation!,
				firstKeptEntryId: branchEntries.at(-1)?.id ?? "",
				previousSummary: "진행상황 ".repeat(10_000),
			},
			100_000,
			"summarization-timeout",
			{
				taskIntent: "Finish the current repair",
				todoSnapshot: { items: ["verify recovery"] },
				checkpoint: { files: ["agent-session.ts"] },
			},
			branchEntries,
		);

		expect(result).toBeDefined();
		expect(result!.summary).not.toContain("�");
		expect(result!.details).toMatchObject({
			taskIntent: "Finish the current repair",
			todoSnapshot: { items: ["verify recovery"] },
			checkpoint: { files: ["agent-session.ts"] },
			retainedSuffix: "prepared",
		});
		harness.sessionManager.appendCompaction(
			result!.summary,
			result!.firstKeptEntryId,
			result!.tokensBefore,
			result!.details,
			true,
		);
		expect(JSON.stringify(harness.sessionManager.buildSessionContext().messages)).toContain("Keep latest request");
	});

	it("accepts the reconstructed retained context exactly at the input cap and rejects one token below", () => {
		const harness = createBlockingContext({ usageTokens: 9_900 });
		const branchEntries = harness.ctx.sessionManager.getBranch();
		const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings(), true)!;
		const retainedPreparation = { ...preparation, firstKeptEntryId: branchEntries.at(-1)?.id ?? "" };
		const roomy = createRequiredCompactionFallback(
			retainedPreparation,
			100_000,
			"summarization-timeout",
			{},
			branchEntries,
		)!;
		const exactWindow = roomy.estimatedTokensAfter! + preparation.settings.reserveTokens;

		const exact = createRequiredCompactionFallback(
			retainedPreparation,
			exactWindow,
			"summarization-timeout",
			{},
			branchEntries,
		);
		const below = createRequiredCompactionFallback(
			retainedPreparation,
			exactWindow - 1,
			"summarization-timeout",
			{},
			branchEntries,
		);

		expect(exact?.estimatedTokensAfter).toBe(roomy.estimatedTokensAfter);
		expect(below).toBeUndefined();
	});
});
