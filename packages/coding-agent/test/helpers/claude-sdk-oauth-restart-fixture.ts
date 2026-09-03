import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { expect } from "vitest";
import type { SdkQueryHandle } from "../../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { forgetBinding } from "../../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import {
	closeSession,
	getOrCreateSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { sentMessageHashes } from "../../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

/** Shared fixture for the issue #6981 restart-continuity regressions (lifecycle + compaction re-anchor). */
export type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
export type BranchEntry = {
	id: string;
	type: string;
	parentId?: string;
	customType?: string;
	content?: unknown;
	display?: boolean;
	data?: unknown;
	message?: unknown;
	summary?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	timestamp?: number;
};

export const SESSION_ID = "issue-6981";
export const PROMPT_HASH = "1".repeat(64);
export const TOOLSET_HASH = "2".repeat(64);
const temporaryDirectories: string[] = [];

export function fakeQuery(): SdkQueryHandle {
	return { async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {}, async interrupt() {}, close() {} };
}

export function assistant(text = "turn one"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "claude-sdk-oauth",
		provider: "claude-sdk-oauth",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

export function sessionFixture() {
	const directory = mkdtempSync(join(tmpdir(), "issue-6981-restart-"));
	temporaryDirectories.push(directory);
	const sessionFile = join(directory, "session.jsonl");
	writeFileSync(sessionFile, "", "utf8");
	// A real `-p -c` turn persists its user message before the assistant commits,
	// and that message is what the restart record anchors its sent-prefix on.
	const userMessage = {
		role: "user" as const,
		content: [{ type: "text" as const, text: "turn one" }],
		timestamp: 1,
	};
	const branch: BranchEntry[] = [{ type: "message", id: "user-entry", message: userMessage }];
	return { sessionFile, branch, contextMessages: [userMessage], turnHashes: sentMessageHashes([userMessage]) };
}

export function fakeExtension(branch: BranchEntry[]) {
	const handlers = new Map<string, EventHandler[]>();
	const persisted: Array<{ customType: string; data: unknown }> = [];
	const api = {
		on(event: string, handler: EventHandler): void {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry(customType: string, data: unknown): void {
			const id = `custom-${branch.length + 1}`;
			branch.push({ type: "custom", id, customType, data });
			persisted.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	return { api, handlers, persisted };
}

export function context(sessionFile: string, branch: BranchEntry[], messages: AgentMessage[]): ExtensionContext {
	return {
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getSessionFile: () => sessionFile,
			getBranch: () => branch,
			getLeafId: () => branch[branch.length - 1]?.id ?? null,
			buildSessionContext: () => ({ messages }),
		},
	} as unknown as ExtensionContext;
}

export async function emit(
	handlers: Map<string, EventHandler[]>,
	eventName: string,
	event: unknown,
	eventContext: ExtensionContext,
): Promise<void> {
	const registered = handlers.get(eventName) ?? [];
	expect(registered).toHaveLength(1);
	for (const handler of registered) await handler(event, eventContext);
}

/** Tear down the registry, process bindings, and every temp session directory this fixture created. */
export function cleanupRestartFixture(): void {
	closeSession(SESSION_ID, "test_cleanup");
	forgetBinding(SESSION_ID);
	resetSessionRegistryBoundary();
	for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
	temporaryDirectories.length = 0;
}

export function residentEntry() {
	overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
	const entry = getOrCreateSession({
		senpiSessionId: SESSION_ID,
		accountName: "default",
		modelId: "claude-test",
		systemPromptHash: PROMPT_HASH,
		toolsetHash: TOOLSET_HASH,
		options: {},
	});
	entry.sentCount = 1;
	entry.sdkSessionIdConfirmed = true;
	entry.assistantUuidByIndex.set(1, "assistant-uuid-1");
	return entry;
}
