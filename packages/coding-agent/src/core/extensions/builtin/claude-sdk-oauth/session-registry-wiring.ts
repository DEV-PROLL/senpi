import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../types.ts";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "./account-management.ts";
import {
	type ClaudeSdkOauthSessionEntry,
	closeSession,
	getSession,
	markTainted,
	recordBranchInfo,
} from "./session-registry.ts";
import {
	installAssistantProvenanceHooks,
	type SentMessage,
	type SessionAssistantProvenanceHooks,
	sessionSyncDigest,
} from "./session-sync.ts";

type AssistantProvenance = { afterSentCount: number; hash: string };

const provenanceByMessages = new WeakMap<readonly SentMessage[], AssistantProvenance[]>();
const provenanceByHashes = new WeakMap<readonly string[], AssistantProvenance[]>();
const provenanceByEntry = new WeakMap<ClaudeSdkOauthSessionEntry, AssistantProvenance[]>();
const stagedHashByEntry = new WeakMap<ClaudeSdkOauthSessionEntry, string>();

function assistantHash(message: AssistantMessage): string {
	return sessionSyncDigest({
		role: message.role,
		api: message.api,
		provider: message.provider,
		model: message.model,
		content: message.content,
	});
}

const assistantProvenanceHooks: SessionAssistantProvenanceHooks = {
	captureMessages(context, messages) {
		let sentCount = 0;
		const provenance: AssistantProvenance[] = [];
		for (const message of context.messages) {
			if (message.role === "assistant") {
				provenance.push({ afterSentCount: sentCount, hash: assistantHash(message) });
			} else {
				sentCount++;
			}
		}
		provenanceByMessages.set(messages, provenance);
	},
	captureHashes(messages, hashes) {
		const provenance = provenanceByMessages.get(messages);
		if (provenance) provenanceByHashes.set(hashes, provenance);
	},
	matches(entry, hashes, branchPrefix) {
		const current = provenanceByHashes.get(hashes);
		const resident = provenanceByEntry.get(entry) ?? [];
		if (!current) return false;
		const expected = branchPrefix ? resident.filter((item) => item.afterSentCount < hashes.length) : resident;
		return (
			current.length === expected.length &&
			current.every(
				(item, index) =>
					item.afterSentCount === expected[index]?.afterSentCount && item.hash === expected[index]?.hash,
			)
		);
	},
	record(entry, hashes) {
		const provenance = provenanceByHashes.get(hashes);
		if (provenance)
			provenanceByEntry.set(
				entry,
				provenance.map((item) => ({ ...item })),
			);
	},
	prime(entry, previous, from) {
		const provenance = (provenanceByEntry.get(previous) ?? []).filter((item) => item.afterSentCount <= from);
		provenanceByEntry.set(entry, provenance);
	},
};

function stageAssistantProvenance(entry: ClaudeSdkOauthSessionEntry, message: AssistantMessage): void {
	stagedHashByEntry.set(entry, assistantHash(message));
}

function commitAssistantProvenance(entry: ClaudeSdkOauthSessionEntry, message: AssistantMessage): boolean {
	const hash = assistantHash(message);
	const stagedHash = stagedHashByEntry.get(entry);
	stagedHashByEntry.delete(entry);
	if (stagedHash !== hash) return false;
	const provenance = provenanceByEntry.get(entry) ?? [];
	const latest = provenance.at(-1);
	if (latest?.afterSentCount === entry.sentCount) return latest.hash === hash;
	provenanceByEntry.set(entry, [...provenance, { afterSentCount: entry.sentCount, hash }]);
	return true;
}

function isResidentAssistant(message: AssistantMessage, modelId: string): boolean {
	return (
		message.api === CLAUDE_SDK_OAUTH_PROVIDER_ID &&
		message.provider === CLAUDE_SDK_OAUTH_PROVIDER_ID &&
		message.model === modelId &&
		message.stopReason !== "error" &&
		message.stopReason !== "aborted"
	);
}

export function registerSessionRegistry(pi: Pick<ExtensionAPI, "on">): void {
	installAssistantProvenanceHooks(assistantProvenanceHooks);
	pi.on("session_compact", (_event, ctx) => {
		markTainted(ctx.sessionManager.getSessionId(), "compaction");
	});
	pi.on("session_before_fork", (_event, ctx) => {
		markTainted(ctx.sessionManager.getSessionId(), "fork");
	});
	pi.on("session_tree", (event, ctx) => {
		if (event.oldLeafId === null || event.newLeafId === null) return;
		recordBranchInfo(ctx.sessionManager.getSessionId(), {
			oldLeafId: event.oldLeafId,
			newLeafId: event.newLeafId,
		});
	});
	pi.on("model_select", (_event, ctx) => {
		closeSession(ctx.sessionManager.getSessionId(), "model_selected");
	});
	pi.on("thinking_level_select", (_event, ctx) => {
		closeSession(ctx.sessionManager.getSessionId(), "thinking_level_selected");
	});
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const entry = getSession(ctx.sessionManager.getSessionId());
		if (entry && isResidentAssistant(event.message, entry.modelId)) {
			stageAssistantProvenance(entry, event.message);
		}
	});
	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const entry = getSession(ctx.sessionManager.getSessionId());
		if (entry && isResidentAssistant(event.message, entry.modelId)) {
			stageAssistantProvenance(entry, event.message);
		}
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const sessionId = ctx.sessionManager.getSessionId();
		const entry = getSession(sessionId);
		if (!entry) return;
		if (!isResidentAssistant(event.message, entry.modelId) || !commitAssistantProvenance(entry, event.message)) {
			markTainted(sessionId, "assistant_provenance_unverified");
		}
	});
	pi.on("session_shutdown", (event, ctx) => {
		closeSession(ctx.sessionManager.getSessionId(), event.reason);
	});
	pi.on("session_extensions_removed", (_event, ctx) => {
		closeSession(ctx.sessionManager.getSessionId(), "extensions_removed");
	});
}
