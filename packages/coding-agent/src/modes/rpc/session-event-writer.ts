import { serializeJsonLine } from "./jsonl.ts";

type RawWriter = (chunk: string) => void;
type FlushScheduler = (flush: () => void) => void;
type RpcRecord = Record<string, unknown>;
type CompactDeltaType = "text_delta" | "thinking_delta" | "toolcall_delta";

type QueueNode = {
	value: RpcRecord;
	key?: string;
	previous?: QueueNode;
	next?: QueueNode;
};

type SessionQueue = {
	head?: QueueNode;
	tail?: QueueNode;
	latestByKey: Map<string, QueueNode>;
};

const MESSAGE_KEY = "message";
const COMPACT_DELTA_TYPES = new Set<CompactDeltaType>(["text_delta", "thinking_delta", "toolcall_delta"]);

function compactDelta(value: RpcRecord): { type: CompactDeltaType; contentIndex: number; delta: string } | undefined {
	if (value.type !== "message_update" || !Object.hasOwn(value, "message")) return undefined;
	const event = value.assistantMessageEvent;
	if (typeof event !== "object" || event === null) return undefined;
	const typedEvent = event as Record<string, unknown>;
	if (
		typeof typedEvent.type !== "string" ||
		!COMPACT_DELTA_TYPES.has(typedEvent.type as CompactDeltaType) ||
		typeof typedEvent.contentIndex !== "number" ||
		typeof typedEvent.delta !== "string"
	) {
		return undefined;
	}
	return {
		type: typedEvent.type as CompactDeltaType,
		contentIndex: typedEvent.contentIndex,
		delta: typedEvent.delta,
	};
}

function toolUpdateKey(value: RpcRecord): string | undefined {
	return value.type === "tool_execution_update" && typeof value.toolCallId === "string"
		? `tool:${value.toolCallId}`
		: undefined;
}

/**
 * Process-wide stdout scheduler for multi-session RPC mode.
 *
 * Each queue contains complete structured JSONL records for one routing handle.
 * Draining takes one record per queue in round-robin order, so a busy session
 * cannot reorder another ready session's next complete record. A record is
 * deliberately written by itself: coalescing records from different sessions
 * would obscure the scheduling boundary and violate D9.
 */
export class SessionEventWriter {
	private readonly queues = new Map<string, SessionQueue>();
	private readonly readySessions: string[] = [];
	private readonly sealedSessions = new Set<string>();
	private readonly writeRaw: RawWriter;
	private readonly scheduleFlush: FlushScheduler;
	private flushScheduled = false;
	private flushing = false;

	constructor(writeRaw: RawWriter, scheduleFlush: FlushScheduler = queueMicrotask) {
		this.writeRaw = writeRaw;
		this.scheduleFlush = scheduleFlush;
	}

	/** Queue one session-owned response, event, or extension UI request. */
	enqueue(sessionId: string, value: object): boolean {
		if (this.sealedSessions.has(sessionId)) return false;
		this.appendSessionRecord(sessionId, { ...value, sessionId });
		this.requestFlush();
		return true;
	}

	/**
	 * Prevent subsequent records for a session and append its terminal response.
	 * Existing records retain FIFO order; this response is therefore that
	 * session's final stdout record.
	 */
	closeSession(sessionId: string, response: object): void {
		if (this.sealedSessions.has(sessionId)) return;
		this.sealedSessions.add(sessionId);
		this.appendSessionRecord(sessionId, { ...response, sessionId });
		this.requestFlush();
	}

	/** Synchronously drain all currently complete records in fair queue order. */
	flush(): void {
		if (this.flushing) return;
		this.flushScheduled = false;
		this.flushing = true;
		try {
			while (this.readySessions.length > 0) {
				const sessionId = this.readySessions.shift()!;
				const queue = this.queues.get(sessionId);
				const node = queue?.head;
				if (!queue || !node) continue;

				this.unlink(queue, node);
				// Exactly one complete record per write. In particular, records from
				// different sessions must never share a batch.
				this.writeRaw(serializeJsonLine(node.value));
				if (queue.head) {
					this.readySessions.push(sessionId);
				} else {
					this.queues.delete(sessionId);
				}
			}
		} finally {
			this.flushing = false;
		}
	}

	private appendSessionRecord(sessionId: string, value: RpcRecord): void {
		let queue = this.queues.get(sessionId);
		if (!queue) {
			queue = { latestByKey: new Map() };
			this.queues.set(sessionId, queue);
			this.readySessions.push(sessionId);
		}

		const delta = compactDelta(value);
		if (delta) {
			const previousFull = queue.latestByKey.get(MESSAGE_KEY);
			if (previousFull) this.demoteAndMerge(queue, previousFull);
			const node = this.append(queue, value, MESSAGE_KEY);
			queue.latestByKey.set(MESSAGE_KEY, node);
			return;
		}

		const toolKey = toolUpdateKey(value);
		if (toolKey) {
			const previous = queue.latestByKey.get(toolKey);
			if (previous) this.unlink(queue, previous);
			const node = this.append(queue, value, toolKey);
			queue.latestByKey.set(toolKey, node);
			return;
		}

		// All non-compactable records are ordering barriers. In particular this
		// includes delta-only/full non-delta message updates, protocol responses,
		// extension UI requests, errors, retries, lifecycle, and unknown records.
		queue.latestByKey.clear();
		this.append(queue, value);
	}

	private demoteAndMerge(queue: SessionQueue, node: QueueNode): void {
		const event = node.value.assistantMessageEvent as Record<string, unknown>;
		node.value = {
			...node.value,
			message: null,
			assistantMessageEvent: { ...event, partial: null },
		};
		const current = compactDelta(node.value);
		const preceding = node.previous;
		const previous = preceding ? compactDelta(preceding.value) : undefined;
		if (
			preceding &&
			previous &&
			current &&
			preceding.value.message === null &&
			previous.type === current.type &&
			previous.contentIndex === current.contentIndex
		) {
			const precedingEvent = preceding.value.assistantMessageEvent as Record<string, unknown>;
			preceding.value = {
				...preceding.value,
				assistantMessageEvent: { ...precedingEvent, delta: previous.delta + current.delta },
			};
			this.unlink(queue, node);
		}
	}

	private append(queue: SessionQueue, value: RpcRecord, key?: string): QueueNode {
		const node: QueueNode = { value, key, previous: queue.tail };
		if (queue.tail) queue.tail.next = node;
		else queue.head = node;
		queue.tail = node;
		return node;
	}

	private unlink(queue: SessionQueue, node: QueueNode): void {
		if (node.previous) node.previous.next = node.next;
		else queue.head = node.next;
		if (node.next) node.next.previous = node.previous;
		else queue.tail = node.previous;
		if (node.key && queue.latestByKey.get(node.key) === node) queue.latestByKey.delete(node.key);
		node.previous = undefined;
		node.next = undefined;
	}

	private requestFlush(): void {
		if (this.flushScheduled || this.flushing) return;
		this.flushScheduled = true;
		this.scheduleFlush(() => this.flush());
	}
}
