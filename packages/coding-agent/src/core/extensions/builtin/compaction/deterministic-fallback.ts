import { type CompactionPreparation, type CompactionResult, estimateTokens } from "../../../compaction/index.ts";
import { StreamDurationBudgetError, StreamIdleTimeoutError } from "../../../compaction/stream-watchdog.ts";
import { filterContextExcludedMessages } from "../../../messages.ts";
import { buildSessionContext, type CompactionEntry, type SessionEntry } from "../../../session-manager.ts";
import { SummarizationOverflowExhaustedError } from "./overflow-retry.ts";
import { hasUnsafeRetainedContent } from "./retained-message-safety.ts";
import { SummaryRequestError } from "./speculative.ts";
import { capUtf8Bytes } from "./task-intent.ts";

export type RequiredCompactionFallbackFailure =
	| "summarization-timeout"
	| "upstream-stream-truncated"
	| "summarization-overflow-exhausted";

interface RecoveryMetadata {
	taskIntent?: string;
	todoSnapshot?: unknown;
	checkpoint?: unknown;
}

export type DeterministicFallbackRejectionReason =
	| "missing-preparation-boundary"
	| "unsafe-retained-content"
	| "retained-token-budget-exceeded"
	| "atomic-tool-chain-cut"
	| "context-reconstruction-failed";

interface DeterministicFallbackDetails {
	schema: "senpi.compaction.deterministic-fallback.v1";
	origin: "required-compaction-recovery";
	failureKind: RequiredCompactionFallbackFailure;
	taskIntent?: string;
	retainedSuffix?: "prepared" | "latest-user-turn" | "earlier-safe-boundary";
}

export interface DeterministicFallbackDiagnostic {
	rejectionReason?: DeterministicFallbackRejectionReason;
	candidatesChecked?: number;
	budgetExceeded?: boolean;
}

const NON_VISIBLE_USER_TEXT = /[\p{White_Space}\p{Default_Ignorable_Code_Point}]/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasMeaningfulUserText(entry: SessionEntry): boolean {
	if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") return false;
	const content = entry.message.content;
	const hasVisibleText = (text: unknown): boolean =>
		typeof text === "string" && text.normalize("NFKC").replace(NON_VISIBLE_USER_TEXT, "").length > 0;
	if (typeof content === "string") return hasVisibleText(content);
	if (!Array.isArray(content)) return false;
	return content.some((block) => isRecord(block) && block.type === "text" && hasVisibleText(block.text));
}

/**
 * Validates that retained tool calls and tool results remain paired in proper sequence,
 * and that we do not cut through an atomic signed/tool chain.
 */
function hasValidToolChains(messages: ReturnType<typeof filterContextExcludedMessages>): boolean {
	const declaredCalls = new Set<string>();
	const resolvedCalls = new Set<string>();

	for (const msg of messages) {
		if (!isRecord(msg)) continue;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string") {
					declaredCalls.add(block.id);
				}
			}
		} else if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
			// A tool result without its preceding tool call in the retained messages is an invalid cut
			if (!declaredCalls.has(msg.toolCallId)) {
				return false;
			}
			resolvedCalls.add(msg.toolCallId);
		}
	}
	return true;
}

/**
 * Bound a value graph that came from persisted, potentially hostile session data.
 * Returns false when the graph contains anything we must not read (accessors,
 * non-plain prototypes, cycles, functions, symbols) so callers fail closed
 * instead of executing persisted code or walking unbounded structures.
 */
function isSafeBoundedValue(value: unknown, seen = new Set<object>(), depth = 0): boolean {
	if (depth > 32) return false;
	if (value === null || value === undefined) return true;
	const kind = typeof value;
	if (kind === "string" || kind === "number" || kind === "boolean") return true;
	if (kind !== "object") return false;
	if (seen.has(value as object)) return false;
	seen.add(value as object);
	if (Array.isArray(value)) {
		for (const item of value) if (!isSafeBoundedValue(item, seen, depth + 1)) return false;
		return true;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
		if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
		if (typeof descriptor.value === "function" || typeof descriptor.value === "symbol") return false;
		if (!isSafeBoundedValue(descriptor.value, seen, depth + 1)) return false;
	}
	return true;
}

/**
 * Conservative retained-context size. Fails closed (Infinity) on any unsafe or
 * un-serializable value, and exits early once `budget` is exceeded so an
 * oversized retained message cannot force an allocation-heavy full scan.
 */
function estimateConservativeTokens(
	messages: ReturnType<typeof filterContextExcludedMessages>,
	budget: number,
): number {
	let total = 0;
	for (const message of messages) {
		if (!isSafeBoundedValue(message)) return Number.POSITIVE_INFINITY;
		let serialized: string | undefined;
		try {
			serialized = JSON.stringify(message);
		} catch {
			return Number.POSITIVE_INFINITY;
		}
		if (serialized === undefined) return Number.POSITIVE_INFINITY;
		total += Math.max(estimateTokens(message), Buffer.byteLength(serialized));
		if (total > budget) return total;
	}
	return total;
}

export function classifyRequiredCompactionFallbackFailure(
	error: unknown,
): RequiredCompactionFallbackFailure | undefined {
	if (error instanceof StreamDurationBudgetError || error instanceof StreamIdleTimeoutError) {
		return "summarization-timeout";
	}
	if (error instanceof SummaryRequestError && error.transient && error.failureKind === "upstream-stream-truncated") {
		return "upstream-stream-truncated";
	}
	if (error instanceof SummarizationOverflowExhaustedError) {
		return "summarization-overflow-exhausted";
	}
	return undefined;
}

export function createRequiredCompactionFallback(
	preparation: CompactionPreparation,
	contextWindow: number,
	failureKind: RequiredCompactionFallbackFailure,
	metadata: RecoveryMetadata,
	branchEntries: SessionEntry[] = [],
	diagnostics?: DeterministicFallbackDiagnostic,
): CompactionResult<DeterministicFallbackDetails> | undefined {
	const preparedBoundaryIndex = branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
	if (!preparation.firstKeptEntryId || preparedBoundaryIndex === -1) {
		if (diagnostics) diagnostics.rejectionReason = "missing-preparation-boundary";
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
				: `${capUtf8Bytes(previousSummary, Math.max(0, availableBytes - Buffer.byteLength(truncationMarker)))}${truncationMarker}`;
		summary = `${fixedText}\n\nPrevious checkpoint:\n${boundedPrevious}`;
	}

	const baseDetails: DeterministicFallbackDetails = {
		schema: "senpi.compaction.deterministic-fallback.v1",
		origin: "required-compaction-recovery",
		failureKind,
		...(taskIntent ? { taskIntent } : {}),
	};
	let candidateCount = 0;

	const projectCandidate = (
		firstKeptEntryId: string,
		retainedSuffix: NonNullable<DeterministicFallbackDetails["retainedSuffix"]>,
	): CompactionResult<DeterministicFallbackDetails> | undefined => {
		candidateCount++;
		const details = { ...baseDetails, retainedSuffix };
		const result: CompactionResult<DeterministicFallbackDetails> = {
			summary,
			firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details,
		};
		const syntheticCompaction: CompactionEntry = {
			type: "compaction",
			id: "__senpi_deterministic_fallback_preview__",
			parentId: branchEntries.at(-1)?.id ?? null,
			timestamp: new Date(0).toISOString(),
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			details: result.details,
			fromHook: true,
		};
		let retainedMessages: ReturnType<typeof filterContextExcludedMessages>;
		try {
			retainedMessages = filterContextExcludedMessages(
				buildSessionContext([...branchEntries, syntheticCompaction]).messages,
			);
		} catch {
			if (diagnostics) diagnostics.rejectionReason = "context-reconstruction-failed";
			return undefined;
		}
		if (hasUnsafeRetainedContent(retainedMessages)) {
			if (diagnostics) diagnostics.rejectionReason = "unsafe-retained-content";
			return undefined;
		}
		if (!hasValidToolChains(retainedMessages)) {
			if (diagnostics) diagnostics.rejectionReason = "atomic-tool-chain-cut";
			return undefined;
		}
		const budget = contextWindow - preparation.settings.reserveTokens;
		const retainedTokens = estimateConservativeTokens(retainedMessages, budget);
		if (retainedTokens > budget) {
			if (diagnostics) {
				diagnostics.rejectionReason = "retained-token-budget-exceeded";
				diagnostics.budgetExceeded = true;
			}
			return undefined;
		}
		return { ...result, estimatedTokensAfter: retainedTokens };
	};

	// 1. Try prepared boundary
	const prepared = projectCandidate(preparation.firstKeptEntryId, "prepared");
	if (prepared) {
		if (diagnostics) diagnostics.candidatesChecked = candidateCount;
		return prepared;
	}

	// 2. If prepared boundary cut an atomic signed chain or was rejected, check if an earlier safe boundary exists
	// Scan backward up to 5 entries before prepared boundary to find complete chain boundary
	const minBoundary = Math.max(0, preparedBoundaryIndex - 5);
	for (let index = preparedBoundaryIndex - 1; index >= minBoundary; index--) {
		const entry = branchEntries[index];
		if (entry.type === "compaction") break;
		// Only consider message turn starts or assistant call starts
		const earlier = projectCandidate(entry.id, "earlier-safe-boundary");
		if (earlier) {
			if (diagnostics) diagnostics.candidatesChecked = candidateCount;
			return earlier;
		}
	}

	// 3. Try latest meaningful user turn
	for (let index = branchEntries.length - 1; index > preparedBoundaryIndex; index--) {
		const entry = branchEntries[index];
		if (!hasMeaningfulUserText(entry)) continue;
		const latestUser = projectCandidate(entry.id, "latest-user-turn");
		if (latestUser) {
			if (diagnostics) diagnostics.candidatesChecked = candidateCount;
			return latestUser;
		}
		break;
	}

	if (diagnostics) diagnostics.candidatesChecked = candidateCount;
	return undefined;
}
