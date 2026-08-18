import { BoundedAsyncQueue, SESSION_STREAM_QUEUE_CAPACITY } from "./bounded-queue.ts";
import type { SDKMessage, SDKUserMessage } from "./sdk-boundary.ts";
import { bindingFromEntry, rememberBinding } from "./session-reattach.ts";
import {
	type ClaudeSdkOauthSessionEntry,
	closeSession,
	isCurrentGeneration,
	sessionRegistry,
} from "./session-registry.ts";
import { submitSessionTurn } from "./session-registry-pump.ts";
import { recordSyncedStream } from "./session-sync.ts";

type StagedContinuityDecision = { emit(): void };

function successfulTurn(messages: readonly SDKMessage[]): boolean {
	return messages.some((message) => message.type === "result" && message.subtype === "success");
}

function recordAssistantUuid(entry: ClaudeSdkOauthSessionEntry, sentCount: number, message: SDKMessage): void {
	if (message.type === "assistant" && message.parent_tool_use_id === null) {
		entry.assistantUuidByIndex.set(sentCount, message.uuid);
	}
}

export function createSessionTurnAttempt(
	entry: ClaudeSdkOauthSessionEntry,
	message: SDKUserMessage["message"],
	hashes: readonly string[],
	signal: AbortSignal | undefined,
	staged: StagedContinuityDecision,
) {
	const generation = entry.generation;
	return {
		messages: (async function* (): AsyncGenerator<SDKMessage> {
			const queue = new BoundedAsyncQueue<SDKMessage>(SESSION_STREAM_QUEUE_CAPACITY);
			const completion = submitSessionTurn(sessionRegistry, entry, {
				message,
				signal,
				onMessage: (sdkMessage) => {
					recordAssistantUuid(entry, hashes.length, sdkMessage);
					queue.push(sdkMessage);
				},
			});
			void completion.then(
				() => queue.close(),
				(error: unknown) => queue.fail(error),
			);
			try {
				for await (const sdkMessage of queue) yield sdkMessage;
				const turn = await completion;
				if (!turn.aborted && successfulTurn(turn.messages)) {
					recordSyncedStream(entry, hashes);
					rememberBinding(bindingFromEntry(entry, hashes));
				}
			} finally {
				staged.emit();
			}
		})(),
		discard: (): void => {
			if (isCurrentGeneration(entry.senpiSessionId, generation)) {
				closeSession(entry.senpiSessionId, "attempt_discarded");
			}
		},
	};
}
