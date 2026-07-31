import { type CompactionPreparation, type CompactionResult, estimateContextTokens } from "../../../compaction/index.ts";
import { StreamDurationBudgetError, StreamIdleTimeoutError } from "../../../compaction/stream-watchdog.ts";
import { buildSessionContext, type CompactionEntry, type SessionEntry } from "../../../session-manager.ts";
import { capUtf8Bytes } from "./task-intent.ts";

export type RequiredCompactionFallbackFailure = "summarization-timeout" | "upstream-stream-truncated";

interface RecoveryMetadata {
	taskIntent?: string;
	todoSnapshot?: unknown;
	checkpoint?: unknown;
}

interface DeterministicFallbackDetails extends RecoveryMetadata {
	schema: "senpi.compaction.deterministic-fallback.v1";
	origin: "required-compaction-recovery";
	failureKind: RequiredCompactionFallbackFailure;
	retainedSuffix?: "prepared";
}

export function classifyRequiredCompactionFallbackFailure(
	error: unknown,
	displayMessage: string,
): RequiredCompactionFallbackFailure | undefined {
	if (error instanceof StreamDurationBudgetError || error instanceof StreamIdleTimeoutError) {
		return "summarization-timeout";
	}
	if (/(?:^|[^A-Za-z0-9_])upstream_stream_truncated(?:[^A-Za-z0-9_]|$)/.test(displayMessage)) {
		return "upstream-stream-truncated";
	}
	return undefined;
}

export function createRequiredCompactionFallback(
	preparation: CompactionPreparation,
	contextWindow: number,
	failureKind: RequiredCompactionFallbackFailure,
	metadata: RecoveryMetadata,
	branchEntries: SessionEntry[] = [],
): CompactionResult<DeterministicFallbackDetails> | undefined {
	if (
		!preparation.firstKeptEntryId ||
		!branchEntries.some((entry) => entry.id === preparation.firstKeptEntryId)
	) {
		return undefined;
	}

	const marker = [
		"[Deterministic compaction recovery checkpoint]",
		"Generated summarization did not complete, so older context was reduced without another provider request.",
		"Continue from the retained messages after this checkpoint. Treat omitted transcript details as unknown.",
	].join("\n");
	const taskIntent = metadata.taskIntent?.trim();
	const fixedText = taskIntent ? `${marker}\n\nTask intent:\n${taskIntent}` : marker;
	const maxSummaryBytes = Math.max(1_024, Math.floor(contextWindow * 0.4));
	const previousSummary = preparation.previousSummary?.trim();
	let summary = fixedText;
	if (previousSummary) {
		const availableBytes = Math.max(0, maxSummaryBytes - Buffer.byteLength(`${fixedText}\n\nPrevious checkpoint:\n`));
		const truncationMarker = "\n[Older checkpoint truncated]";
		const boundedPrevious =
			Buffer.byteLength(previousSummary) <= availableBytes
				? previousSummary
				: `${capUtf8Bytes(
						previousSummary,
						Math.max(0, availableBytes - Buffer.byteLength(truncationMarker)),
					)}${truncationMarker}`;
		summary = `${fixedText}\n\nPrevious checkpoint:\n${boundedPrevious}`;
	}

	const baseDetails: DeterministicFallbackDetails = {
		schema: "senpi.compaction.deterministic-fallback.v1",
		origin: "required-compaction-recovery",
		failureKind,
		...(taskIntent ? { taskIntent } : {}),
		...(metadata.todoSnapshot ? { todoSnapshot: metadata.todoSnapshot } : {}),
		...(metadata.checkpoint ? { checkpoint: metadata.checkpoint } : {}),
	};
	const result: CompactionResult<DeterministicFallbackDetails> = {
		summary,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: baseDetails,
	};

	const maxInputTokens = contextWindow - preparation.settings.reserveTokens;
	const projectTokens = (candidate: CompactionResult<DeterministicFallbackDetails>): number => {
		const syntheticCompaction: CompactionEntry = {
			type: "compaction",
			id: "__senpi_deterministic_fallback_preview__",
			parentId: branchEntries.at(-1)?.id ?? null,
			timestamp: new Date(0).toISOString(),
			summary: candidate.summary,
			firstKeptEntryId: candidate.firstKeptEntryId,
			tokensBefore: candidate.tokensBefore,
			details: candidate.details,
			fromHook: true,
		};
		return estimateContextTokens(buildSessionContext([...branchEntries, syntheticCompaction]).messages).tokens;
	};
	const retainedTokens = projectTokens(result);
	if (retainedTokens <= maxInputTokens) {
		return {
			...result,
			estimatedTokensAfter: retainedTokens,
			details: { ...baseDetails, retainedSuffix: "prepared" },
		};
	}

	return undefined;
}
