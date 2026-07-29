import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createStartupLoadingIndicator,
	pauseIndicatorDuringPrompts,
	type StartupLoadingIndicator,
	shouldShowStartupLoadingIndicator,
} from "../src/cli/startup-loading-indicator.ts";
import type { ProjectTrustContext } from "../src/core/extensions/types.ts";

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const CLEAR_LINE = "\r\u001b[2K";
const FRAMES = ["A", "B", "C"] as const;

function makeIndicator(overrides: { isTTY?: boolean } = {}): {
	indicator: StartupLoadingIndicator;
	writes: string[];
} {
	const writes: string[] = [];
	const indicator = createStartupLoadingIndicator({
		writer: (chunk) => writes.push(chunk),
		isTTY: overrides.isTTY ?? true,
		label: "Loading senpi",
		graceMs: 120,
		intervalMs: 80,
		frames: FRAMES,
	});
	return { indicator, writes };
}

describe("createStartupLoadingIndicator", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("writes nothing before the grace delay and nothing when stopped within it", () => {
		const { indicator, writes } = makeIndicator();
		indicator.start();
		vi.advanceTimersByTime(119);
		expect(writes).toEqual([]);
		indicator.stop();
		vi.advanceTimersByTime(1000);
		expect(writes).toEqual([]);
	});

	it("draws the first frame after the grace delay with a hidden cursor", () => {
		const { indicator, writes } = makeIndicator();
		indicator.start();
		vi.advanceTimersByTime(120);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain(HIDE_CURSOR);
		expect(writes[0]).toContain(CLEAR_LINE);
		expect(writes[0]).toContain("A");
		expect(writes[0]).toContain("Loading senpi");
	});

	it("animates frames on the interval, rewriting a single line", () => {
		const { indicator, writes } = makeIndicator();
		indicator.start();
		vi.advanceTimersByTime(120);
		vi.advanceTimersByTime(80);
		vi.advanceTimersByTime(80);
		expect(writes).toHaveLength(3);
		expect(writes[1]).toContain(CLEAR_LINE);
		expect(writes[1]).toContain("B");
		expect(writes[1]).not.toContain(HIDE_CURSOR);
		expect(writes[2]).toContain("C");
	});

	it("setPhase updates the rendered line immediately once drawing", () => {
		const { indicator, writes } = makeIndicator();
		indicator.start();
		vi.advanceTimersByTime(120);
		indicator.setPhase("opening session");
		expect(writes.at(-1)).toContain("opening session");
	});

	it("pause clears the line and suppresses writes; resume redraws", () => {
		const { indicator, writes } = makeIndicator();
		indicator.start();
		vi.advanceTimersByTime(120);
		indicator.pause();
		const pauseWrite = writes.at(-1) ?? "";
		expect(pauseWrite).toContain(CLEAR_LINE);
		expect(pauseWrite).toContain(SHOW_CURSOR);
		expect(pauseWrite).not.toContain("Loading senpi");
		const countAfterPause = writes.length;
		vi.advanceTimersByTime(800);
		expect(writes).toHaveLength(countAfterPause);
		indicator.resume();
		expect(writes.length).toBeGreaterThan(countAfterPause);
		expect(writes.at(-1)).toContain("Loading senpi");
		const countAfterResume = writes.length;
		vi.advanceTimersByTime(80);
		expect(writes.length).toBeGreaterThan(countAfterResume);
	});

	it("stop clears the line, restores the cursor, and is idempotent", () => {
		const { indicator, writes } = makeIndicator();
		indicator.start();
		vi.advanceTimersByTime(120);
		indicator.stop();
		const stopWrite = writes.at(-1) ?? "";
		expect(stopWrite).toContain(CLEAR_LINE);
		expect(stopWrite).toContain(SHOW_CURSOR);
		const countAfterStop = writes.length;
		vi.advanceTimersByTime(1000);
		indicator.stop();
		expect(writes).toHaveLength(countAfterStop);
	});

	it("stop while paused emits nothing extra", () => {
		const { indicator, writes } = makeIndicator();
		indicator.start();
		vi.advanceTimersByTime(120);
		indicator.pause();
		const countAfterPause = writes.length;
		indicator.stop();
		expect(writes).toHaveLength(countAfterPause);
	});

	it("is completely inert without a TTY", () => {
		const { indicator, writes } = makeIndicator({ isTTY: false });
		indicator.start();
		vi.advanceTimersByTime(1000);
		indicator.stop();
		expect(writes).toEqual([]);
	});

	it("registers an exit listener while running and removes it on stop", () => {
		const before = process.listeners("exit").length;
		const { indicator } = makeIndicator();
		indicator.start();
		expect(process.listeners("exit").length).toBe(before + 1);
		indicator.stop();
		expect(process.listeners("exit").length).toBe(before);
	});
});

describe("shouldShowStartupLoadingIndicator", () => {
	it("engages only for interactive mode on a TTY without --help", () => {
		expect(
			shouldShowStartupLoadingIndicator({ appMode: "interactive", stdoutIsTTY: true, helpRequested: false }),
		).toBe(true);
		expect(shouldShowStartupLoadingIndicator({ appMode: "print", stdoutIsTTY: true, helpRequested: false })).toBe(
			false,
		);
		expect(shouldShowStartupLoadingIndicator({ appMode: "rpc", stdoutIsTTY: true, helpRequested: false })).toBe(
			false,
		);
		expect(
			shouldShowStartupLoadingIndicator({ appMode: "interactive", stdoutIsTTY: false, helpRequested: false }),
		).toBe(false);
		expect(
			shouldShowStartupLoadingIndicator({ appMode: "interactive", stdoutIsTTY: true, helpRequested: true }),
		).toBe(false);
	});
});

describe("pauseIndicatorDuringPrompts", () => {
	function makeContext(events: string[], behavior: { reject?: boolean } = {}): ProjectTrustContext {
		return {
			cwd: "/tmp/project",
			mode: "tui",
			hasUI: true,
			ui: {
				select: async (_title, _options) => {
					events.push("select");
					if (behavior.reject) throw new Error("prompt failed");
					return "picked";
				},
				confirm: async (_title, _message) => {
					events.push("confirm");
					return true;
				},
				input: async (_title, _placeholder) => {
					events.push("input");
					return "typed";
				},
				notify: (_message, _type) => {
					events.push("notify");
				},
			},
		};
	}

	function makePauseSpy(events: string[]): Pick<StartupLoadingIndicator, "pause" | "resume"> {
		return {
			pause: () => events.push("pause"),
			resume: () => events.push("resume"),
		};
	}

	it("pauses around select/confirm/input and passes results through", async () => {
		const events: string[] = [];
		const wrapped = pauseIndicatorDuringPrompts(makeContext(events), makePauseSpy(events));
		await expect(wrapped.ui.select("t", ["a"])).resolves.toBe("picked");
		await expect(wrapped.ui.confirm("t", "m")).resolves.toBe(true);
		await expect(wrapped.ui.input("t", "p")).resolves.toBe("typed");
		expect(events).toEqual(["pause", "select", "resume", "pause", "confirm", "resume", "pause", "input", "resume"]);
	});

	it("resumes even when the prompt rejects", async () => {
		const events: string[] = [];
		const wrapped = pauseIndicatorDuringPrompts(makeContext(events, { reject: true }), makePauseSpy(events));
		await expect(wrapped.ui.select("t", ["a"])).rejects.toThrow("prompt failed");
		expect(events).toEqual(["pause", "select", "resume"]);
	});

	it("leaves notify untouched", () => {
		const events: string[] = [];
		const wrapped = pauseIndicatorDuringPrompts(makeContext(events), makePauseSpy(events));
		wrapped.ui.notify("hello", "info");
		expect(events).toEqual(["notify"]);
	});
});
