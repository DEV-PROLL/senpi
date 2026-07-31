import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type AuthenticatedAttemptInput, queryWithAuthLane } from "./auth-lane.ts";
import { buildPromptBlocks } from "./prompt-bridge.ts";
import type { SDKMessage, SDKUserMessage } from "./sdk-boundary.ts";
import { getSdkBoundary } from "./sdk-boundary.ts";
import {
	type ClaudeSdkOauthSessionEntry,
	closeSession,
	getOrCreateSession,
	getSession,
	isBoundAccountTokenExpiring,
	isCurrentGeneration,
	sessionRegistry,
} from "./session-registry.ts";
import { submitSessionTurn } from "./session-registry-pump.ts";
import {
	buildDeltaPromptBlocks,
	configFingerprint,
	decideSessionSync,
	primeResumedEntry,
	recordSyncedStream,
	sentMessageHashes,
	sentMessages,
} from "./session-sync.ts";
import type { ClaudeSdkOauthProviderSettings } from "./settings.ts";

export type ResidentSessionStreamInput = {
	model: Model<Api>;
	context: Context;
	streamOptions: SimpleStreamOptions;
	providerSettings: ClaudeSdkOauthProviderSettings;
	pinnedAccount?: string;
	buildOptions: Parameters<typeof queryWithAuthLane>[0]["buildOptions"];
	customToolNameToSdk: ReadonlyMap<string, string>;
	toolWatchNote?: string;
	onResumeFallback: (error: unknown) => void;
};

function userMessage(content: SDKUserMessage["message"]["content"]): SDKUserMessage["message"] {
	return { role: "user", content } as SDKUserMessage["message"];
}

function successfulTurn(messages: readonly SDKMessage[]): boolean {
	return messages.some((message) => message.type === "result" && message.subtype === "success");
}

function recordAssistantUuid(entry: ClaudeSdkOauthSessionEntry, sentCount: number, message: SDKMessage): void {
	if (message.type === "assistant" && message.parent_tool_use_id === null) {
		entry.assistantUuidByIndex.set(sentCount, message.uuid);
	}
}

function turnAttempt(
	entry: ClaudeSdkOauthSessionEntry,
	message: SDKUserMessage["message"],
	hashes: readonly string[],
	signal: AbortSignal | undefined,
) {
	const generation = entry.generation;
	return {
		messages: (async function* (): AsyncGenerator<SDKMessage> {
			const turn = await submitSessionTurn(sessionRegistry, entry, {
				message,
				signal,
				onMessage: (sdkMessage) => recordAssistantUuid(entry, hashes.length, sdkMessage),
			});
			for (const sdkMessage of turn.messages) yield sdkMessage;
			if (!turn.aborted && successfulTurn(turn.messages)) recordSyncedStream(entry, hashes);
		})(),
		discard: (): void => {
			if (isCurrentGeneration(entry.senpiSessionId, generation))
				closeSession(entry.senpiSessionId, "attempt_discarded");
		},
	};
}

async function createResidentAttempt(
	input: ResidentSessionStreamInput,
	auth: AuthenticatedAttemptInput,
): Promise<ReturnType<typeof turnAttempt>> {
	const sessionId = input.streamOptions.sessionId!;
	const messages = sentMessages(input.context);
	const hashes = sentMessageHashes(messages);
	const existing = getSession(sessionId);
	const fingerprint = configFingerprint(auth.options, input.context, auth.authLane, auth.accountName);
	const decision = decideSessionSync({
		entry: existing,
		currentHashes: hashes,
		accountName: auth.accountName,
		modelId: input.model.id,
		fingerprint,
		tokenExpiring: existing ? isBoundAccountTokenExpiring(existing, auth.accounts) : false,
	});
	let entry: ClaudeSdkOauthSessionEntry;
	let from = 0;
	let coldSeed = decision.kind === "cold-seed";
	if (decision.kind === "incremental") {
		entry = existing!;
		from = decision.from;
	} else if (decision.kind === "resume") {
		const previous = existing!;
		closeSession(sessionId, "branch_resume");
		entry = getOrCreateSession({
			senpiSessionId: sessionId,
			accountName: auth.accountName,
			modelId: input.model.id,
			...fingerprint,
			options: {
				...auth.options,
				resume: decision.previousSdkSessionId,
				resumeSessionAt: decision.resumeSessionAt,
				forkSession: true,
			},
		});
		primeResumedEntry(entry, previous, decision.from);
		try {
			if (!entry.query.initializationResult)
				throw new Error("Resumed Claude SDK query has no initialization result");
			await entry.query.initializationResult();
			from = decision.from;
			coldSeed = false;
		} catch (error) {
			closeSession(sessionId, "resume_initialization_failed");
			input.onResumeFallback(error);
			coldSeed = true;
			entry = getOrCreateSession({
				senpiSessionId: sessionId,
				accountName: auth.accountName,
				modelId: input.model.id,
				...fingerprint,
				options: auth.options,
			});
		}
	} else {
		if (existing) closeSession(sessionId, decision.reason);
		entry = getOrCreateSession({
			senpiSessionId: sessionId,
			accountName: auth.accountName,
			modelId: input.model.id,
			...fingerprint,
			options: auth.options,
		});
	}
	const blocks = coldSeed
		? buildPromptBlocks(input.context, input.customToolNameToSdk, input.toolWatchNote)
		: buildDeltaPromptBlocks(messages.slice(from), input.customToolNameToSdk);
	return turnAttempt(entry, userMessage(blocks), hashes, input.streamOptions.signal);
}

export function residentSessionMessages(input: ResidentSessionStreamInput): AsyncIterable<SDKMessage> {
	return queryWithAuthLane({
		prompt: "",
		query: getSdkBoundary().query,
		providerSettings: input.providerSettings,
		sessionId: input.streamOptions.affinitySessionId ?? input.streamOptions.sessionId,
		pinnedAccount: input.pinnedAccount,
		buildOptions: input.buildOptions,
		createAttempt: (auth) => createResidentAttempt(input, auth),
	});
}
