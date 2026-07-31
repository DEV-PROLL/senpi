import { Buffer } from "node:buffer";
import type { SDKMessage, SDKUserMessage } from "./sdk-boundary.ts";
import {
	type ClaudeSdkOauthSessionEntry,
	type ClaudeSdkOauthSessionRegistry,
	createSessionUuid,
} from "./session-registry.ts";
import {
	transitionToIdleSynced,
	transitionToTurnClaimed,
	transitionToTurnResultSeen,
	transitionToTurnSent,
	transitionToTurnStreaming,
	transitionToTurnWaiting,
} from "./session-registry-state.ts";

export const DEFAULT_PRE_REPLAY_MAX_MESSAGES = 64;
export const DEFAULT_PRE_REPLAY_MAX_BYTES = 256 * 1024;

export interface SessionTurnRequest {
	message: SDKUserMessage["message"];
	signal?: AbortSignal;
	onMessage?: (message: SDKMessage) => void;
}

export interface SessionTurnResult {
	uuid: string;
	messages: SDKMessage[];
	aborted: boolean;
}

export interface PreReplayBufferLimits {
	maxMessages: number;
	maxBytes: number;
}

interface ActiveTurn {
	uuid: string;
	generation: number;
	messages: SDKMessage[];
	preReplay: SDKMessage[];
	preReplayBytes: number;
	claimed: boolean;
	aborted: boolean;
	interruptRequested: boolean;
	resultSeen: boolean;
	onMessage?: (message: SDKMessage) => void;
	signal?: AbortSignal;
	onAbort: () => void;
	resolve: (result: SessionTurnResult) => void;
	reject: (error: Error) => void;
	limits: PreReplayBufferLimits;
}

export class ConcurrentSessionTurnAdmissionError extends Error {
	readonly code = "claude_sdk_oauth_concurrent_turn_admission";

	constructor(sessionId: string) {
		super(`Concurrent Claude SDK OAuth turn admission for session ${sessionId}`);
		this.name = "ConcurrentSessionTurnAdmissionError";
	}
}

export class SessionTurnAttributionError extends Error {
	readonly code = "claude_sdk_oauth_turn_attribution";

	constructor(message: string) {
		super(message);
		this.name = "SessionTurnAttributionError";
	}
}

function currentTurn(entry: ClaudeSdkOauthSessionEntry): ActiveTurn | null {
	return entry.activeTurn as ActiveTurn | null;
}

function setCurrentTurn(entry: ClaudeSdkOauthSessionEntry, turn: ActiveTurn | null): void {
	entry.activeTurn = turn;
}

function isReplayFor(message: SDKMessage, uuid: string): boolean {
	return message.type === "user" && "isReplay" in message && message.isReplay === true && message.uuid === uuid;
}

function isAutonomousResult(message: Extract<SDKMessage, { type: "result" }>): boolean {
	if (message.origin && message.origin.kind !== "human") return true;
	const wire = message as SDKMessage & {
		parent_tool_use_id?: unknown;
		subagent_type?: unknown;
		isSynthetic?: unknown;
	};
	return wire.parent_tool_use_id != null || wire.subagent_type != null || wire.isSynthetic === true;
}

function resultMatchesTurn(message: Extract<SDKMessage, { type: "result" }>, turn: ActiveTurn): boolean {
	if ("user_message_uuid" in message && message.user_message_uuid !== undefined) {
		return message.user_message_uuid === turn.uuid;
	}
	return turn.claimed && !turn.resultSeen && !isAutonomousResult(message);
}

function startStreaming(entry: ClaudeSdkOauthSessionEntry): void {
	if (entry.state === "TURN_CLAIMED") transitionToTurnStreaming(entry);
}

function deliver(entry: ClaudeSdkOauthSessionEntry, turn: ActiveTurn, message: SDKMessage): void {
	startStreaming(entry);
	turn.messages.push(message);
	turn.onMessage?.(message);
}

function removeAbortListener(turn: ActiveTurn): void {
	turn.signal?.removeEventListener("abort", turn.onAbort);
}

function failTurn(registry: ClaudeSdkOauthSessionRegistry, entry: ClaudeSdkOauthSessionEntry, error: Error): void {
	const turn = currentTurn(entry);
	if (turn) {
		removeAbortListener(turn);
		setCurrentTurn(entry, null);
		turn.reject(error);
	}
	if (registry.isCurrentGeneration(entry.senpiSessionId, entry.generation)) {
		registry.closeSession(entry.senpiSessionId, error.message);
	}
}

function bufferBeforeReplay(
	registry: ClaudeSdkOauthSessionRegistry,
	entry: ClaudeSdkOauthSessionEntry,
	turn: ActiveTurn,
	message: SDKMessage,
): void {
	turn.preReplay.push(message);
	turn.preReplayBytes += Buffer.byteLength(JSON.stringify(message));
	if (turn.preReplay.length > turn.limits.maxMessages || turn.preReplayBytes > turn.limits.maxBytes) {
		throw new SessionTurnAttributionError("Claude SDK OAuth pre-replay buffer overflow");
	}
	if (!registry.isCurrentGeneration(entry.senpiSessionId, turn.generation)) turn.preReplay.length = 0;
}

function claimTurn(entry: ClaudeSdkOauthSessionEntry, turn: ActiveTurn): void {
	turn.claimed = true;
	transitionToTurnClaimed(entry);
	for (const buffered of turn.preReplay) deliver(entry, turn, buffered);
	turn.preReplay.length = 0;
	turn.preReplayBytes = 0;
}

function finishTurn(
	registry: ClaudeSdkOauthSessionRegistry,
	entry: ClaudeSdkOauthSessionEntry,
	turn: ActiveTurn,
	message: Extract<SDKMessage, { type: "result" }>,
): void {
	if (!resultMatchesTurn(message, turn)) {
		throw new SessionTurnAttributionError("Claude SDK OAuth result user_message_uuid did not match the active turn");
	}
	turn.resultSeen = true;
	startStreaming(entry);
	if (!turn.aborted) deliver(entry, turn, message);
	transitionToTurnResultSeen(entry);
	removeAbortListener(turn);
	setCurrentTurn(entry, null);
	if (turn.aborted) registry.markTainted(entry.senpiSessionId, "abort");
	else transitionToIdleSynced(entry);
	turn.resolve({ uuid: turn.uuid, messages: turn.messages, aborted: turn.aborted });
}

function handleMessage(
	registry: ClaudeSdkOauthSessionRegistry,
	entry: ClaudeSdkOauthSessionEntry,
	message: SDKMessage,
): void {
	const turn = currentTurn(entry);
	if (!turn || !registry.isCurrentGeneration(entry.senpiSessionId, turn.generation)) return;
	if (!turn.claimed) {
		if (isReplayFor(message, turn.uuid)) claimTurn(entry, turn);
		else if (message.type === "stream_event") bufferBeforeReplay(registry, entry, turn, message);
		else if (message.type === "result") {
			throw new SessionTurnAttributionError("Claude SDK OAuth result arrived before replay claim");
		}
		return;
	}
	if (message.type === "user" && "isReplay" in message && message.isReplay === true) return;
	if (message.type === "result") finishTurn(registry, entry, turn, message);
	else deliver(entry, turn, message);
}

async function runPump(registry: ClaudeSdkOauthSessionRegistry, entry: ClaudeSdkOauthSessionEntry): Promise<void> {
	const iterator = entry.query[Symbol.asyncIterator]();
	try {
		while (true) {
			const { value, done } = await iterator.next();
			if (done) {
				failTurn(registry, entry, new Error("Claude SDK OAuth query ended before the active turn completed"));
				return;
			}
			handleMessage(registry, entry, value);
		}
	} catch (error) {
		failTurn(registry, entry, error instanceof Error ? error : new Error(String(error)));
	}
}

export function submitSessionTurn(
	registry: ClaudeSdkOauthSessionRegistry,
	entry: ClaudeSdkOauthSessionEntry,
	request: SessionTurnRequest,
	limits: PreReplayBufferLimits = {
		maxMessages: DEFAULT_PRE_REPLAY_MAX_MESSAGES,
		maxBytes: DEFAULT_PRE_REPLAY_MAX_BYTES,
	},
): Promise<SessionTurnResult> {
	if (currentTurn(entry)) throw new ConcurrentSessionTurnAdmissionError(entry.senpiSessionId);
	if (entry.state === "STARTING") transitionToIdleSynced(entry);
	transitionToTurnWaiting(entry);
	const uuid = createSessionUuid();
	let turn!: ActiveTurn;
	const promise = new Promise<SessionTurnResult>((resolve, reject) => {
		const onAbort = (): void => {
			if (turn.interruptRequested) return;
			turn.aborted = true;
			turn.interruptRequested = true;
			void entry.query.interrupt().catch(() => {});
		};
		turn = {
			uuid,
			generation: entry.generation,
			messages: [],
			preReplay: [],
			preReplayBytes: 0,
			claimed: false,
			aborted: false,
			interruptRequested: false,
			resultSeen: false,
			onMessage: request.onMessage,
			signal: request.signal,
			onAbort,
			resolve,
			reject,
			limits,
		};
	});
	setCurrentTurn(entry, turn);
	if (!entry.pumpTask) entry.pumpTask = runPump(registry, entry);
	entry.inputController.push({
		type: "user",
		message: request.message,
		parent_tool_use_id: null,
		uuid,
		session_id: entry.sdkSessionId,
	});
	transitionToTurnSent(entry);
	if (request.signal?.aborted) turn.onAbort();
	else request.signal?.addEventListener("abort", turn.onAbort, { once: true });
	return promise;
}
