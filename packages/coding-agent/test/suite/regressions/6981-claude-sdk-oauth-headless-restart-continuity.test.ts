import { afterEach, describe, expect, it } from "vitest";
import {
	BINDING_ENTRY_TYPE,
	BINDING_MARKER,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-binding.ts";
import { readStoredBinding } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-binding-store.ts";
import { decideNativeContinuity } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";
import {
	bindingFromEntry,
	forgetBinding,
	getBinding,
	rememberBinding,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import { closeSession } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-registry-wiring.ts";
import {
	recordSyncedStream,
	sentHashPrefixDigest,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";
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

describe("issue #6981 headless restart continuity", () => {
	it("invalidates persisted continuity when the committed assistant is rewritten", async () => {
		const { sessionFile, branch, contextMessages, turnHashes } = sessionFixture();
		const extension = fakeExtension(branch);
		registerSessionRegistry(extension.api);
		const entry = residentEntry();
		rememberBinding(bindingFromEntry(entry, turnHashes));
		const eventContext = context(sessionFile, branch, contextMessages);

		await emit(
			extension.handlers,
			"message_update",
			{ type: "message_update", message: assistant("provider final") },
			eventContext,
		);
		await emit(
			extension.handlers,
			"message_end",
			{ type: "message_end", message: assistant("committed rewrite") },
			eventContext,
		);

		expect(extension.persisted).toEqual([
			{
				customType: BINDING_ENTRY_TYPE,
				data: { schemaVersion: 1, invalidated: true, reason: "assistant_rewritten" },
			},
		]);
		expect(getBinding(SESSION_ID)).toBeUndefined();
	});

	it("restores a sidecar-bound SDK lineage after a separate process starts", async () => {
		const { sessionFile, branch, contextMessages, turnHashes } = sessionFixture();
		const extension = fakeExtension(branch);
		registerSessionRegistry(extension.api);
		const entry = residentEntry();
		rememberBinding(bindingFromEntry(entry, turnHashes));
		const eventContext = context(sessionFile, branch, contextMessages);
		recordSyncedStream(entry, turnHashes);
		closeSession(SESSION_ID, "other");

		await emit(extension.handlers, "message_end", { type: "message_end", message: assistant() }, eventContext);
		branch.push({ type: "message", id: "assistant-entry", message: assistant() });
		branch.push(
			{
				type: "custom_message",
				id: "goal-continuation",
				customType: "goal-continuation",
				content: "Continue working toward the active thread goal.",
				display: false,
			},
			{
				type: "custom",
				id: "goal-cache",
				customType: "goal-cache-warmup",
				data: { phase: "scheduled" },
			},
		);

		expect(extension.persisted).toEqual([{ customType: BINDING_ENTRY_TYPE, data: BINDING_MARKER }]);
		expect(await readStoredBinding(sessionFile)).toMatchObject({
			sessionId: SESSION_ID,
			sdkSessionId: entry.sdkSessionId,
			sentCount: 1,
		});

		closeSession(SESSION_ID, "process_exit");
		forgetBinding(SESSION_ID);

		const restarted = fakeExtension(branch);
		registerSessionRegistry(restarted.api);
		await emit(restarted.handlers, "session_start", { type: "session_start", reason: "resume" }, eventContext);

		const restored = getBinding(SESSION_ID);
		expect(restored).toMatchObject({
			sdkSessionId: entry.sdkSessionId,
			sentCount: 1,
			lastAssistantUuid: "assistant-uuid-1",
		});
		expect(
			decideNativeContinuity({
				entry: undefined,
				binding: restored,
				currentHashes: turnHashes,
				accountName: "default",
				modelId: "claude-test",
				fingerprint: { systemPromptHash: PROMPT_HASH, toolsetHash: TOOLSET_HASH },
				transcriptAvailable: true,
			}),
		).toMatchObject({ kind: "reattach", reason: "registry_miss" });
	});

	it("anchors and reattaches a contentless first turn at count zero", async () => {
		const { sessionFile, branch } = sessionFixture();
		branch[0].message = { role: "user", content: [], timestamp: 1 };
		const extension = fakeExtension(branch);
		registerSessionRegistry(extension.api);
		const entry = residentEntry();
		entry.sentCount = 0;
		entry.assistantUuidByIndex.clear();
		const eventContext = context(sessionFile, branch, [{ role: "user", content: [], timestamp: 1 }]);

		await emit(extension.handlers, "message_end", { type: "message_end", message: assistant() }, eventContext);
		const stored = await readStoredBinding(sessionFile);
		expect(stored).toMatchObject({ sentCount: 0, sentPrefixHash: sentHashPrefixDigest([]) });

		branch.push({ type: "message", id: "assistant-entry", message: assistant() });
		closeSession(SESSION_ID, "process_exit");
		forgetBinding(SESSION_ID);
		const restarted = fakeExtension(branch);
		registerSessionRegistry(restarted.api);
		await emit(restarted.handlers, "session_start", { type: "session_start", reason: "resume" }, eventContext);
		expect(
			decideNativeContinuity({
				entry: undefined,
				binding: getBinding(SESSION_ID),
				currentHashes: [],
				accountName: "default",
				modelId: entry.modelId,
				fingerprint: { systemPromptHash: PROMPT_HASH, toolsetHash: TOOLSET_HASH },
				transcriptAvailable: true,
			}),
		).toMatchObject({ kind: "reattach" });
	});
});
