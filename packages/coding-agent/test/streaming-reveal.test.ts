import { afterEach, describe, expect, test, vi } from "vitest";
import {
	DEFAULT_SMOOTH_FPS,
	INITIAL_BUFFER_MS,
	MAX_SMOOTH_FPS,
	MIN_SMOOTH_FPS,
	nextStep,
} from "../src/modes/interactive/streaming-reveal.ts";
import {
	latestMessage,
	makeController,
	makeMessage,
	RecordingComponent,
	textAt,
	thinkingAt,
} from "./helpers/streaming-reveal.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("StreamingRevealController", () => {
	test("#given an active reveal #when begin replaces it #then cancels the old interval", () => {
		vi.useFakeTimers();
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "first" }]));
		controller.begin(new RecordingComponent(), makeMessage([{ type: "text", text: "second" }]));

		expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
		controller.stop();
	});

	test("#given a provider burst #when the startup buffer is still filling #then text remains queued", () => {
		vi.useFakeTimers();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const { component, controller, requestRender } = makeController();
		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "a".repeat(40) }]));
		const updatesBeforeTicks = component.messages.length;

		for (let tick = 1; tick <= 4; tick++) {
			now = tick * (1000 / DEFAULT_SMOOTH_FPS);
			vi.advanceTimersByTime(17);
		}

		expect(component.messages).toHaveLength(updatesBeforeTicks);
		expect(requestRender).not.toHaveBeenCalled();
		controller.stop();
	});

	test("#given a growing target #when ticks advance #then rendered prefixes grow monotonically", () => {
		vi.useFakeTimers();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const { component, controller, requestRender } = makeController();
		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghijklmnopqrst" }]));
		const beforeTicks = component.messages.length;

		for (let tick = 1; tick <= 10; tick++) {
			now = tick * (1000 / DEFAULT_SMOOTH_FPS);
			vi.advanceTimersByTime(17);
		}
		const lengths = component.messages.slice(beforeTicks).map((message) => textAt(message).length);

		expect(lengths.length).toBeGreaterThanOrEqual(3);
		expect(lengths.every((length, index) => index === 0 || length > lengths[index - 1]!)).toBe(true);
		expect(requestRender).toHaveBeenCalledTimes(lengths.length);
		controller.stop();
	});

	test("#given an event-loop stall #when a tick runs #then clamps real performance delta to 100ms", () => {
		vi.useFakeTimers();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const { component, controller } = makeController({ fps: () => MIN_SMOOTH_FPS });
		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "a".repeat(1000) }]));

		now = 1000;
		vi.advanceTimersByTime(34);

		expect(textAt(latestMessage(component))).toHaveLength(nextStep(1000, 100));
		controller.stop();
	});

	test("#given an active reveal #when smoothing is disabled #then snaps full and cancels pacing", () => {
		vi.useFakeTimers();
		let smooth = true;
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const { component, controller, requestRender } = makeController({ smooth: () => smooth });
		controller.begin(component, makeMessage([{ type: "text", text: "chunk" }]));

		smooth = false;
		const finalTarget = makeMessage([{ type: "text", text: "chunky" }]);
		controller.setTarget(finalTarget);
		const updates = component.messages.length;
		vi.advanceTimersByTime(1000);

		expect(latestMessage(component)).toBe(finalTarget);
		expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
		expect(component.messages).toHaveLength(updates);
		expect(requestRender).not.toHaveBeenCalled();
	});

	test("#given a partial reveal #when a tool call arrives #then jumps to full text and cancels ticking", () => {
		vi.useFakeTimers();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const { component, controller } = makeController({ fps: () => MIN_SMOOTH_FPS });
		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "a".repeat(100) }]));
		now = INITIAL_BUFFER_MS + 20;
		vi.advanceTimersByTime(INITIAL_BUFFER_MS + 21);
		const partialText = textAt(latestMessage(component));
		expect(partialText.length).toBeGreaterThan(0);
		expect(partialText.length).toBeLessThan(100);

		const withTool = makeMessage([
			{ type: "text", text: "a".repeat(100) },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
		]);
		controller.setTarget(withTool);
		const updates = component.messages.length;
		vi.advanceTimersByTime(1000);

		expect(latestMessage(component)).toBe(withTool);
		expect(component.messages).toHaveLength(updates);
	});

	test("#given an active reveal #when stopped and final content is flushed directly #then no timer overwrites it", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		controller.begin(component, makeMessage([{ type: "text", text: "streaming" }]));

		controller.stop();
		const finalMessage = makeMessage([{ type: "text", text: "final" }], { stopReason: "length" });
		component.updateContent(finalMessage);
		vi.advanceTimersByTime(1000);

		expect(latestMessage(component)).toBe(finalMessage);
	});

	test("#given visibility changes mid-stream #when resynced #then hidden thinking consumes no units", () => {
		vi.useFakeTimers();
		let now = 0;
		let hidden = false;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const { component, controller } = makeController({
			fps: () => MIN_SMOOTH_FPS,
			hideThinking: () => hidden,
		});
		controller.begin(
			component,
			makeMessage([
				{ type: "thinking", thinking: "think" },
				{ type: "text", text: "answer" },
			]),
		);
		now = INITIAL_BUFFER_MS + 20;
		vi.advanceTimersByTime(INITIAL_BUFFER_MS + 21);
		const partialThinking = thinkingAt(latestMessage(component));
		expect(partialThinking.length).toBeGreaterThan(0);

		hidden = true;
		controller.resyncVisibility();

		expect(thinkingAt(latestMessage(component))).toBe("think");
		expect(textAt(latestMessage(component), 1)).toBe("answer");
		controller.stop();
	});

	test("#given fps changes while active #when target resyncs #then restarts at the clamped fps", () => {
		vi.useFakeTimers();
		let fps = DEFAULT_SMOOTH_FPS;
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const { component, controller } = makeController({ fps: () => fps });
		const target = makeMessage([{ type: "text", text: "a".repeat(100) }]);
		controller.begin(component, target);

		fps = 500;
		controller.setTarget(target);

		expect(setIntervalSpy).toHaveBeenNthCalledWith(1, expect.any(Function), 1000 / DEFAULT_SMOOTH_FPS);
		expect(setIntervalSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 1000 / MAX_SMOOTH_FPS);
		expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
		controller.stop();
	});

	test("#given a fully drained burst #when a later burst starts #then fractional progress does not leak across the gap", () => {
		vi.useFakeTimers();
		const frameMs = 1000 / MAX_SMOOTH_FPS;
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const { component, controller } = makeController({ fps: () => MAX_SMOOTH_FPS });
		controller.begin(component, makeMessage([{ type: "text", text: "abc" }]));

		for (let frame = 1; frame <= 17; frame++) {
			now = frame * frameMs;
			vi.advanceTimersByTime(9);
		}
		expect(textAt(latestMessage(component))).toBe("abc");

		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghijklm" }]));
		now = 18 * frameMs;
		vi.advanceTimersByTime(9);

		expect(textAt(latestMessage(component))).toBe("abc");
		controller.stop();
	});

	test("#given an active reveal #when its timer starts #then the handle is unrefed", () => {
		const unref = vi.fn();
		const handle = { unref } as unknown as NodeJS.Timeout;
		vi.spyOn(globalThis, "setInterval").mockReturnValue(handle);
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "pending" }]));

		expect(unref).toHaveBeenCalledTimes(1);
		controller.stop();
	});
});
