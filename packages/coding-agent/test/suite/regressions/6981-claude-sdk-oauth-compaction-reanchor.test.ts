import { afterEach, describe, expect, it } from "vitest";
import { readStoredBinding } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-binding-store.ts";
import { decideNativeContinuity } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";
import { forgetBinding, getBinding } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import { closeSession } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-registry-wiring.ts";
import {
	sentHashPrefixDigest,
	sentMessageHashes,
	sentMessages,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import {
	assistant,
	cleanupRestartFixture,
	context,
	emit,
	fakeExtension,
	PROMPT_HASH,
	residentEntry,
	SESSION_ID,
	sessionFixture,
	TOOLSET_HASH,
} from "../../helpers/claude-sdk-oauth-restart-fixture.ts";

afterEach(() => {
	cleanupRestartFixture();
});

describe("issue #6981 compaction restart continuity", () => {
	it("persists the admission projection and reattaches after compaction", async () => {
		const { sessionFile, branch } = sessionFixture();
		branch[0] = { type: "message", id: "user-entry", message: { role: "user" as const, content: [], timestamp: 1 } };
		const compactionSummary = {
			role: "compactionSummary" as const,
			summary: "Earlier work summarized.",
			tokensBefore: 200_000,
			timestamp: 2,
		};
		const currentUser = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "after compaction" }],
			timestamp: 3,
		};
		branch.push(
			{
				type: "compaction",
				id: "compaction-entry",
				parentId: "user-entry",
				summary: "Earlier work summarized.",
				firstKeptEntryId: "user-entry",
				tokensBefore: 200_000,
				timestamp: 2,
			},
			{
				type: "message",
				id: "current-user",
				parentId: "compaction-entry",
				message: { role: "user" as const, content: [], timestamp: 3 },
			},
		);
		const extension = fakeExtension(branch);
		registerSessionRegistry(extension.api);
		const entry = residentEntry();
		const contextMessages = [compactionSummary, currentUser];
		const eventContext = context(sessionFile, branch, contextMessages);
		const expectedHashes = sentMessageHashes(sentMessages({ messages: convertToLlm(contextMessages) }));

		await emit(extension.handlers, "message_end", { type: "message_end", message: assistant() }, eventContext);
		const stored = await readStoredBinding(sessionFile);
		expect(stored).toMatchObject({
			sessionId: SESSION_ID,
			sdkSessionId: entry.sdkSessionId,
			sentCount: expectedHashes.length,
			sentPrefixHash: sentHashPrefixDigest(expectedHashes),
		});

		branch.push({ type: "message", id: "assistant-entry", message: assistant() });
		closeSession(SESSION_ID, "process_exit");
		forgetBinding(SESSION_ID);
		const restarted = fakeExtension(branch);
		registerSessionRegistry(restarted.api);
		await emit(restarted.handlers, "session_start", { type: "session_start", reason: "resume" }, eventContext);
		const restored = getBinding(SESSION_ID);
		expect(
			decideNativeContinuity({
				entry: undefined,
				binding: restored,
				currentHashes: expectedHashes,
				accountName: "default",
				modelId: "claude-test",
				fingerprint: { systemPromptHash: PROMPT_HASH, toolsetHash: TOOLSET_HASH },
				transcriptAvailable: true,
			}),
		).toMatchObject({ kind: "reattach", reason: "registry_miss" });
	});
});
