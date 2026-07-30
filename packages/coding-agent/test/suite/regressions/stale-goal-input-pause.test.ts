/** Locks the stale-goal failure: a newer explicit user request must pause the stale active goal. */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import { GOAL_CONTINUATION_MESSAGE_TYPE } from "../../../src/core/messages.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
	vi.useRealTimers();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

describe("stale goal input pause", () => {
	it("pauses an active goal at the input seam on an idle direct prompt without charging the new turn", async () => {
		const harness = await createHarness({ extensionFactories: [goalExtension] });
		harnesses.push(harness);

		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		const goal = await createGoal(ref, "Complete the quarterly report by analyzing sales data and drafting summary");

		expect(goal.status).toBe("active");
		const goalId = goal.id;
		const tokensBefore = goal.tokensUsed;

		const countContinuations = () =>
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === GOAL_CONTINUATION_MESSAGE_TYPE)
				.length;

		harness.setResponses([fauxAssistantMessage("Python uses indentation and colons for block scope.")]);
		await harness.session.prompt("how does python handle scope?");

		// The newer, unrelated prompt was handled.
		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		expect(getMessageText(lastMessage)).toContain("indentation");

		// Idle input pauses at the seam before the new turn starts.
		const goalAfterPrompt = await readGoal(ref);
		expect(goalAfterPrompt).toMatchObject({ id: goalId, status: "paused" });
		// The unrelated new turn is not charged to the stale goal.
		expect(goalAfterPrompt?.tokensUsed).toBe(tokensBefore);
		expect(countContinuations()).toBe(0);

		// No later continuation resurrects the paused goal under virtual time.
		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(20 * 60_000);
		vi.useRealTimers();
		expect((await readGoal(ref))?.status).toBe("paused");
		expect(countContinuations()).toBe(0);
	}, 20_000);

	it("defers the pause past an in-flight hidden continuation when a newer prompt is queued, then never resumes", async () => {
		const streamStarted = deferred();
		const harness = await createHarness({ extensionFactories: [goalExtension] });
		harnesses.push(harness);

		// Exact stream signal: subscribe to the first assistant message_update BEFORE triggering
		// the queued follow-up, so the injection lands mid-stream (streamingBehavior "followUp").
		let streamed = false;
		harness.session.subscribe((event) => {
			if (event.type === "message_update" && event.message.role === "assistant" && !streamed) {
				streamed = true;
				streamStarted.resolve();
			}
		});

		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		const goal = await createGoal(ref, "Refactor the billing pipeline and migrate every caller across the repo");
		const goalId = goal.id;

		const countContinuations = () =>
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === GOAL_CONTINUATION_MESSAGE_TYPE)
				.length;

		harness.setResponses([
			// The in-flight hidden continuation streams a large response so a follow-up can be queued
			// mid-stream. Extension source keeps the goal active through this turn.
			fauxAssistantMessage("hidden goal continuation progress ".repeat(2_000)),
			// The newer user turn that runs after the deferred pause.
			fauxAssistantMessage("Here is the answer to your newer, unrelated question."),
		]);

		const continuationRun = harness.session.prompt("pursue the active goal", { source: "extension" });
		await streamStarted.promise;
		expect(harness.session.isStreaming).toBe(true);
		// A newer interactive/RPC-equivalent prompt queued while the continuation streams.
		const followUpRun = harness.session.prompt("answer my newer unrelated question instead", {
			streamingBehavior: "followUp",
		});
		await Promise.all([continuationRun, followUpRun]);

		// Pause is deferred to agent_end: the in-flight turn's usage is accounted, then active -> paused.
		const pausedGoal = await readGoal(ref);
		expect(pausedGoal).toMatchObject({ id: goalId, status: "paused" });
		expect(pausedGoal?.tokensUsed).toBeGreaterThan(0);

		// The newer user prompt was handled after the pause.
		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		expect(getMessageText(lastMessage)).toContain("newer");

		// No hidden goal-continuation was delivered by the deferred pause.
		expect(countContinuations()).toBe(0);

		// Deterministic virtual-clock proof: no fallback timer resurrects the paused goal.
		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(20 * 60_000);
		vi.useRealTimers();

		expect((await readGoal(ref))?.status).toBe("paused");
		expect(countContinuations()).toBe(0);
	}, 20_000);
});
