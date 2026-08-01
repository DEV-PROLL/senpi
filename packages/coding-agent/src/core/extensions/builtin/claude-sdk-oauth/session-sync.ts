import { createHash } from "node:crypto";
import type { Context, ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { EXPIRING_WITHIN_MS } from "./auth-lane.ts";
import type { ClaudeSdkOauthAuthLane } from "./options.ts";
import type { Base64ImageSource, ContentBlockParam, Options } from "./sdk-boundary.ts";
import {
	type ClaudeSdkOauthSessionEntry,
	isBoundAccountTokenExpiring,
	SESSION_REGISTRY_IDLE_TTL_MS,
} from "./session-registry.ts";
import { HOST_TOOL_POLICY_FINGERPRINT, mapPiToolNameToSdk } from "./tools.ts";

export type SentMessage = Extract<Message, { role: "user" | "toolResult" }>;

export type SessionConfigFingerprint = {
	systemPromptHash: string;
	toolsetHash: string;
};

export type SessionSyncDecision =
	| { kind: "cold-seed"; reason: string }
	| { kind: "incremental"; from: number }
	| { kind: "resume"; from: number; resumeSessionAt: string; previousSdkSessionId: string };

export type SessionSyncDecisionInput = {
	entry: ClaudeSdkOauthSessionEntry | undefined;
	currentHashes: readonly string[];
	accountName: string;
	modelId: string;
	fingerprint: SessionConfigFingerprint;
	tokenExpiring: boolean;
};

export type SessionAssistantProvenanceHooks = {
	captureMessages(context: Context, messages: readonly SentMessage[]): void;
	captureHashes(messages: readonly SentMessage[], hashes: readonly string[]): void;
	matches(entry: ClaudeSdkOauthSessionEntry, hashes: readonly string[], branchPrefix: boolean): boolean;
	record(entry: ClaudeSdkOauthSessionEntry, hashes: readonly string[]): void;
	prime(entry: ClaudeSdkOauthSessionEntry, previous: ClaudeSdkOauthSessionEntry, from: number): void;
};

const sentHashesByEntry = new WeakMap<ClaudeSdkOauthSessionEntry, string[]>();
let assistantProvenanceHooks: SessionAssistantProvenanceHooks | undefined;

function stableValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "function") return `[function:${value.name}:${value.toString()}]`;
	if (typeof value === "bigint") return value.toString();
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	const normalized = Array.isArray(value)
		? value.map((item) => stableValue(item, seen))
		: Object.fromEntries(
				Object.entries(value as Record<string, unknown>)
					.filter(([, item]) => item !== undefined)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, item]) => [key, stableValue(item, seen)]),
			);
	seen.delete(value);
	return normalized;
}

function digest(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(value)))
		.digest("hex");
}

export function installAssistantProvenanceHooks(hooks: SessionAssistantProvenanceHooks): void {
	assistantProvenanceHooks = hooks;
}

export function sessionSyncDigest(value: unknown): string {
	return digest(value);
}

export function sentMessages(context: Context): SentMessage[] {
	const messages = context.messages.filter(
		(message): message is SentMessage => message.role === "user" || message.role === "toolResult",
	);
	assistantProvenanceHooks?.captureMessages(context, messages);
	return messages;
}

export function sentMessageHashes(messages: readonly SentMessage[]): string[] {
	const hashes = messages.map((message) =>
		digest(
			message.role === "user"
				? { role: message.role, content: message.content }
				: {
						role: message.role,
						toolCallId: message.toolCallId,
						toolName: message.toolName,
						content: message.content,
					},
		),
	);
	assistantProvenanceHooks?.captureHashes(messages, hashes);
	return hashes;
}

function prefixDigest(hashes: readonly string[], count = hashes.length): string {
	return digest(hashes.slice(0, count));
}

function samePrefix(left: readonly string[], right: readonly string[], count: number): boolean {
	if (left.length < count || right.length < count) return false;
	for (let index = 0; index < count; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function resumeBoundary(
	entry: ClaudeSdkOauthSessionEntry,
	currentCount: number,
): { index: number; uuid: string } | undefined {
	return [...entry.assistantUuidByIndex.entries()]
		.filter(([index]) => index < currentCount)
		.sort(([left], [right]) => right - left)
		.map(([index, uuid]) => ({ index, uuid }))[0];
}

function idleTtlExpired(entry: ClaudeSdkOauthSessionEntry): boolean {
	if (entry.activeTurn !== null || (entry.state !== "IDLE_SYNCED" && entry.state !== "TAINTED")) return false;
	return isBoundAccountTokenExpiring(entry, [
		{
			name: entry.accountName,
			expires: entry.lastUsedAt + SESSION_REGISTRY_IDLE_TTL_MS + EXPIRING_WITHIN_MS,
			source: "login",
		},
	]);
}

/** Pure divergence guard: every non-proven continuation resolves to cold-seed. */
export function decideSessionSync(input: SessionSyncDecisionInput): SessionSyncDecision {
	const { entry } = input;
	if (!entry) return { kind: "cold-seed", reason: "registry_miss" };
	if (idleTtlExpired(entry)) return { kind: "cold-seed", reason: "idle_ttl" };
	if (input.tokenExpiring) return { kind: "cold-seed", reason: "bound_account_token_expiring" };
	if (entry.taintedReason) return { kind: "cold-seed", reason: `tainted:${entry.taintedReason}` };
	if (entry.accountName !== input.accountName) return { kind: "cold-seed", reason: "account_changed" };
	if (entry.modelId !== input.modelId) return { kind: "cold-seed", reason: "model_changed" };
	if (entry.toolsetHash !== input.fingerprint.toolsetHash) return { kind: "cold-seed", reason: "toolset_changed" };
	if (entry.systemPromptHash !== input.fingerprint.systemPromptHash) {
		return { kind: "cold-seed", reason: "system_prompt_changed" };
	}
	if (
		assistantProvenanceHooks &&
		!assistantProvenanceHooks.matches(entry, input.currentHashes, entry.branchInfo !== null)
	) {
		return { kind: "cold-seed", reason: "assistant_stream_diverged" };
	}
	const residentHashes = sentHashesByEntry.get(entry) ?? [];
	if (entry.branchInfo) {
		const strictPrefix =
			input.currentHashes.length < entry.sentCount &&
			samePrefix(input.currentHashes, residentHashes, input.currentHashes.length);
		const boundary = strictPrefix ? resumeBoundary(entry, input.currentHashes.length) : undefined;
		return boundary
			? {
					kind: "resume",
					from: boundary.index,
					resumeSessionAt: boundary.uuid,
					previousSdkSessionId: entry.sdkSessionId,
				}
			: { kind: "cold-seed", reason: strictPrefix ? "branch_boundary_unavailable" : "branch_diverged" };
	}
	const prefixMatches =
		entry.sentCount <= input.currentHashes.length &&
		entry.syncedPrefixHash === prefixDigest(input.currentHashes, entry.sentCount) &&
		samePrefix(input.currentHashes, residentHashes, entry.sentCount);
	return prefixMatches
		? { kind: "incremental", from: entry.sentCount }
		: { kind: "cold-seed", reason: "sent_stream_diverged" };
}

export function recordSyncedStream(entry: ClaudeSdkOauthSessionEntry, hashes: readonly string[]): void {
	const copy = [...hashes];
	assistantProvenanceHooks?.record(entry, hashes);
	sentHashesByEntry.set(entry, copy);
	entry.sentCount = copy.length;
	entry.syncedPrefixHash = prefixDigest(copy);
	entry.branchInfo = null;
}

export function primeResumedEntry(
	entry: ClaudeSdkOauthSessionEntry,
	previous: ClaudeSdkOauthSessionEntry,
	from: number,
): void {
	const hashes = (sentHashesByEntry.get(previous) ?? []).slice(0, from);
	assistantProvenanceHooks?.prime(entry, previous, from);
	sentHashesByEntry.set(entry, hashes);
	entry.sentCount = from;
	entry.syncedPrefixHash = prefixDigest(hashes);
	for (const [index, uuid] of previous.assistantUuidByIndex) {
		if (index <= from) entry.assistantUuidByIndex.set(index, uuid);
	}
}

const GENERATED_DATE_LINE = /\nCurrent date: \d{4}-\d{2}-\d{2}(?=\nCurrent working directory: [^\n]*$)/;

/**
 * The generated date line advances at UTC midnight while the conversation is
 * unchanged; hashing it verbatim retires a live session at midnight for no
 * semantic reason. Only that exact terminal line is neutralized - cwd and every
 * other prompt region stay fail-closed.
 */
function fingerprintSystemPrompt(systemPrompt: Options["systemPrompt"]): unknown {
	if (typeof systemPrompt !== "string") return systemPrompt ?? null;
	return systemPrompt.replace(GENERATED_DATE_LINE, "\nCurrent date: <session-date>");
}

export function configFingerprint(
	options: Options,
	context: Context,
	authLane: ClaudeSdkOauthAuthLane,
	accountName: string,
): SessionConfigFingerprint {
	return {
		systemPromptHash: digest(fingerprintSystemPrompt(options.systemPrompt)),
		toolsetHash: digest({
			tools: options.tools ?? [],
			reasoning: {
				thinking: options.thinking,
				effort: options.effort,
				maxThinkingTokens: options.maxThinkingTokens,
			},
			contextTools: (context.tools ?? []).map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
			cwd: options.cwd,
			authLane,
			accountName,
			permissionMode: options.permissionMode,
			hostToolPolicy: HOST_TOOL_POLICY_FINGERPRINT,
			settingSources: options.settingSources,
			extraArgs: options.extraArgs,
			pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
			includePartialMessages: options.includePartialMessages,
		}),
	};
}

function appendContent(blocks: ContentBlockParam[], content: string | readonly (TextContent | ImageContent)[]): void {
	if (typeof content === "string") {
		blocks.push({ type: "text", text: content });
		return;
	}
	for (const block of content) {
		blocks.push(
			block.type === "text"
				? { type: "text", text: block.text }
				: {
						type: "image",
						source: {
							type: "base64",
							media_type: block.mimeType as Base64ImageSource["media_type"],
							data: block.data,
						},
					},
		);
	}
}

export function buildDeltaPromptBlocks(
	messages: readonly SentMessage[],
	customToolNameToSdk?: ReadonlyMap<string, string>,
): ContentBlockParam[] {
	const blocks: ContentBlockParam[] = [];
	for (const [index, message] of messages.entries()) {
		if (index > 0) blocks.push({ type: "text", text: "\n\n" });
		if (message.role === "toolResult") {
			blocks.push({
				type: "text",
				text: `Tool result (${mapPiToolNameToSdk(message.toolName, customToolNameToSdk)}, id=${message.toolCallId}):\n`,
			});
		}
		appendContent(blocks, message.content);
	}
	return blocks;
}
