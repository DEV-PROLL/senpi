import { afterEach, describe, expect, it } from "vitest";
import type { CompactionQueuedMessage } from "../../../src/modes/interactive/compaction-queue-transfer.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

type OrderedMessage = {
	readonly text: string;
	readonly mode: "steer" | "followUp";
	readonly enqueueOrder: number;
};

type ClearedQueues = {
	steering: string[];
	followUp: string[];
	ordered: OrderedMessage[];
};

function clearAllQueues(context: object): ClearedQueues {
	const clear = Reflect.get(InteractiveMode.prototype, "clearAllQueues");
	if (typeof clear !== "function") throw new Error("Expected InteractiveMode.clearAllQueues");
	return clear.call(context) as ClearedQueues;
}

function flushCompactionQueue(
	context: object,
	options: { willRetry: boolean; deferAdmission: boolean },
): Promise<void> {
	const flush = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue");
	if (typeof flush !== "function") throw new Error("Expected InteractiveMode.flushCompactionQueue");
	return Promise.resolve(flush.call(context, options));
}

function queueContext(harness: Harness, messages: CompactionQueuedMessage[]) {
	return {
		compactionQueuedMessages: messages,
		compactionInFlightMessages: [] as CompactionQueuedMessage[],
		compactionTransferAbortControllers: new Map<CompactionQueuedMessage, AbortController>(),
		isExtensionCommand: () => false,
		showError: (message: string) => {
			throw new Error(message);
		},
		updatePendingMessagesDisplay: () => {},
		session: harness.session,
	};
}

function orderedShape(messages: readonly OrderedMessage[]): Array<{ text: string; mode: string }> {
	return messages.map(({ text, mode }) => ({ text, mode }));
}

describe("terminal compaction queue recovery order", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("restores an older follow-up before a newer steering message without changing native queue buckets", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.followUp("older follow-up");
		await harness.session.steer("newer steering");

		const cleared = harness.session.clearQueue();

		expect(cleared).toEqual({ steering: ["newer steering"], followUp: ["older follow-up"] });
		expect(orderedShape(cleared.ordered)).toEqual([
			{ text: "older follow-up", mode: "followUp" },
			{ text: "newer steering", mode: "steer" },
		]);
	});

	it("restores earlier compaction-owned input before later native input", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const compactionMessage = {
			text: "earlier compaction follow-up",
			mode: "followUp" as const,
			enqueueOrder: harness.session.reserveQueuedInputOrder(),
		};
		await harness.session.steer("later native steering");
		const context = queueContext(harness, [compactionMessage]);

		const cleared = clearAllQueues(context);

		expect(orderedShape(cleared.ordered)).toEqual([
			{ text: "earlier compaction follow-up", mode: "followUp" },
			{ text: "later native steering", mode: "steer" },
		]);
	});

	it("retains original order and modes through retryable native handoff before terminal restoration", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const handedOff = {
			text: "first compaction follow-up",
			mode: "followUp" as const,
			enqueueOrder: harness.session.reserveQueuedInputOrder(),
		};
		const context = queueContext(harness, [handedOff]);
		await flushCompactionQueue(context, { willRetry: true, deferAdmission: true });
		await harness.session.steer("second native steering");

		const cleared = clearAllQueues(context);

		expect(orderedShape(cleared.ordered)).toEqual([
			{ text: "first compaction follow-up", mode: "followUp" },
			{ text: "second native steering", mode: "steer" },
		]);
		expect(cleared.followUp).toEqual(["first compaction follow-up"]);
		expect(cleared.steering).toEqual(["second native steering"]);
	});
});
