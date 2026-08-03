import { afterEach, describe, expect, it } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

type QueuedMessage = {
	readonly text: string;
	readonly mode: "steer" | "followUp";
};

type ClearQueueOptions = { abortWillFollow?: boolean };

function getQueueNativeMessage(harness: Harness, mode: "Steer" | "FollowUp") {
	const queue = Reflect.get(harness.session, `_queue${mode}`);
	if (typeof queue !== "function") throw new Error(`Expected AgentSession._queue${mode}`);
	return (text: string): Promise<void> => Promise.resolve(queue.call(harness.session, text));
}

function getClearAllQueues() {
	const clear = Reflect.get(InteractiveMode.prototype, "clearAllQueues");
	if (typeof clear !== "function") throw new Error("Expected InteractiveMode.clearAllQueues");
	return (context: object, options?: ClearQueueOptions): { steering: string[]; followUp: string[] } =>
		clear.call(context, options);
}

function getRestoreQueuedMessagesToEditor() {
	const restore = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor");
	if (typeof restore !== "function") throw new Error("Expected InteractiveMode.restoreQueuedMessagesToEditor");
	return (context: object): number => restore.call(context);
}

function getAbortAndFireQueuedMessages() {
	const abortAndFire = Reflect.get(InteractiveMode.prototype, "abortAndFireQueuedMessages");
	if (typeof abortAndFire !== "function") {
		throw new Error("Expected InteractiveMode.abortAndFireQueuedMessages");
	}
	return (context: object): Promise<number> => Promise.resolve(abortAndFire.call(context));
}

function getHandleEvent() {
	const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent");
	if (typeof handleEvent !== "function") throw new Error("Expected InteractiveMode.handleEvent");
	return (context: object, event: object): Promise<void> => Promise.resolve(handleEvent.call(context, event));
}

function createInteractiveContext(harness: Harness) {
	let editorText = "";
	const context = {
		isInitialized: true,
		session: harness.session,
		compactionQueuedMessages: [] as QueuedMessage[],
		compactionInFlightMessages: [] as QueuedMessage[],
		compactionTransferAbortControllers: new Map<QueuedMessage, AbortController>(),
		compactionEscapeOverrideActive: false,
		autoCompactionEscapeHandler: undefined,
		autoCompactionProgressText: "",
		defaultEditor: {},
		footer: { invalidate: () => {} },
		statusContainer: { clear: () => {} },
		chatContainer: { clear: () => {}, addChild: () => {} },
		clearStatusIndicator: () => {},
		showError: () => {},
		showStatus: () => {},
		getSessionLogger: () => ({ warn: () => {} }),
		settingsManager: { getShowTerminalProgress: () => false },
		ui: { requestRender: () => {}, terminal: { setProgress: () => {} } },
		updatePendingMessagesDisplay: () => {},
		editor: {
			getText: () => editorText,
			setText: (text: string) => {
				editorText = text;
			},
		},
		clearAllQueues(options?: ClearQueueOptions) {
			return getClearAllQueues()(context, options);
		},
		restoreQueuedMessagesToEditor() {
			return getRestoreQueuedMessagesToEditor()(context);
		},
	};
	return { context, getEditorText: () => editorText };
}

async function seedNativeQueues(harness: Harness): Promise<void> {
	await getQueueNativeMessage(harness, "Steer")("native steering");
	await getQueueNativeMessage(harness, "FollowUp")("native follow-up");
}

describe("PR 535 terminal compaction queue restoration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("does not leak restored queue state into a later idle abort", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await seedNativeQueues(harness);
		const { context, getEditorText } = createInteractiveContext(harness);

		await getHandleEvent()(context, {
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			accepted: false,
			aborted: false,
			willRetry: false,
			errorMessage: "synthetic terminal compaction failure",
		});

		expect(getEditorText()).toBe("native steering\n\nnative follow-up");
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);

		const abortEvents: string[] = [];
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "session_abort") abortEvents.push(event.type);
		});
		await harness.session.abort();
		unsubscribe();

		expect(abortEvents).toEqual([]);
	});

	it("still emits session_abort when queue draining immediately precedes abort", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await seedNativeQueues(harness);
		const { context, getEditorText } = createInteractiveContext(harness);
		const abortEvents: string[] = [];
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "session_abort") abortEvents.push(event.type);
		});

		const restored = await getAbortAndFireQueuedMessages()(context);
		unsubscribe();

		expect(restored).toBe(2);
		expect(getEditorText()).toBe("native steering\n\nnative follow-up");
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(abortEvents).toEqual(["session_abort"]);
	});
});
