import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { StoredBinding } from "./session-binding-store.ts";
import { assistantContentHash } from "./session-commit-boundary.ts";
import type { ContinuityBinding } from "./session-reattach.ts";
import { sentHashPrefixDigest } from "./session-sync.ts";

export const BINDING_ENTRY_TYPE = "claude-sdk-oauth-binding";
export const BINDING_MARKER = { schemaVersion: 2, marker: true } as const;

export type BindingInvalidation = {
	readonly schemaVersion: 1;
	readonly invalidated: true;
	readonly reason: string;
};

type BranchEntry = {
	readonly id?: string;
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
	readonly message?: unknown;
};

export type StoredBindingAnchor = {
	readonly sessionPath: string;
	readonly markerEntryId: string;
	readonly assistantContentHash: string;
};

export function storedBindingFromBinding(binding: ContinuityBinding, anchor: StoredBindingAnchor): StoredBinding {
	if (binding.sentHashes.length < binding.sentCount) {
		throw new IncompleteContinuityBindingError(binding.sentCount, binding.sentHashes.length);
	}
	return {
		schemaVersion: 1,
		sessionPath: anchor.sessionPath,
		sessionId: binding.senpiSessionId,
		markerEntryId: anchor.markerEntryId,
		sdkSessionId: binding.sdkSessionId,
		sentCount: binding.sentCount,
		sentPrefixHash: sentHashPrefixDigest(binding.sentHashes, binding.sentCount),
		assistantContentHash: anchor.assistantContentHash,
		lastAssistantUuid: binding.lastAssistantUuid,
		accountName: binding.accountName,
		modelId: binding.modelId,
		systemPromptHash: binding.systemPromptHash,
		toolsetHash: binding.toolsetHash,
	};
}

export function bindingFromStoredBranch(
	branch: readonly BranchEntry[],
	stored: StoredBinding,
): ContinuityBinding | undefined {
	const markerIndex = newestBindingEntryIndex(branch);
	if (markerIndex < 0) return undefined;
	const marker = branch[markerIndex];
	if (
		marker?.id !== stored.markerEntryId ||
		!isBindingMarker(marker.data) ||
		!branch.slice(markerIndex + 2).every(isSafeBindingSuffix)
	) {
		return undefined;
	}
	const committedAssistant = branch[markerIndex + 1]?.message;
	if (!isAssistantMessage(committedAssistant)) return undefined;
	if (assistantContentHash(committedAssistant) !== stored.assistantContentHash) return undefined;
	return bindingFromStored(stored);
}

function isSafeBindingSuffix(entry: BranchEntry): boolean {
	if (entry.type === "label") return true;
	return (
		entry.type === "custom" && (entry.customType === "senpi.hooks.stop-state" || entry.customType === "pi-rules.scan")
	);
}

function newestBindingEntryIndex(branch: readonly BranchEntry[]): number {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type === "custom" && entry.customType === BINDING_ENTRY_TYPE) return index;
	}
	return -1;
}

function isBindingMarker(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	return "schemaVersion" in value && value.schemaVersion === 2 && "marker" in value && value.marker === true;
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	if (typeof value !== "object" || value === null) return false;
	return (
		"role" in value &&
		value.role === "assistant" &&
		"api" in value &&
		typeof value.api === "string" &&
		"provider" in value &&
		typeof value.provider === "string" &&
		"model" in value &&
		typeof value.model === "string" &&
		"content" in value &&
		Array.isArray(value.content)
	);
}

function bindingFromStored(stored: StoredBinding): ContinuityBinding {
	return {
		senpiSessionId: stored.sessionId,
		sdkSessionId: stored.sdkSessionId,
		sentCount: stored.sentCount,
		sentHashes: [],
		sentPrefixHash: stored.sentPrefixHash,
		lastAssistantUuid: stored.lastAssistantUuid,
		assistantUuidByIndex: stored.lastAssistantUuid === null ? [] : [[stored.sentCount, stored.lastAssistantUuid]],
		accountName: stored.accountName,
		modelId: stored.modelId,
		systemPromptHash: stored.systemPromptHash,
		toolsetHash: stored.toolsetHash,
	};
}

class IncompleteContinuityBindingError extends Error {
	constructor(sentCount: number, availableHashes: number) {
		super(`Continuity binding has ${availableHashes} hashes for ${sentCount} sent messages`);
		this.name = "IncompleteContinuityBindingError";
	}
}
