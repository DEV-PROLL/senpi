import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import type { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import type { TerminalRuntimeSession } from "../../src/core/extensions/builtin/terminal/runtime-session.ts";
import { createPtyBashTool } from "../../src/core/extensions/builtin/terminal/tools/bash.ts";
import { createBashOutputTool } from "../../src/core/extensions/builtin/terminal/tools/bash-output.ts";
import type { TerminalToolContext, TerminalToolResult } from "../../src/core/extensions/builtin/terminal/tools/context.ts";

const spawned = vi.hoisted(() => ({
	nextId: 0,
	runtime: undefined as unknown,
	request: undefined as unknown,
	exitAtMs: undefined as number | undefined,
}));

vi.mock("../../src/core/extensions/builtin/terminal/tools/spawn.ts", () => ({
	describeExit: (runtime: { exitResult: { exitCode: number | null; timedOut: boolean; cancelled: boolean } | null }) => {
		const exit = runtime.exitResult;
		if (!exit) return null;
		if (exit.timedOut) return "timed_out";
		if (exit.cancelled) return "killed";
		return exit.exitCode === 0 ? "completed" : `exited_${exit.exitCode}`;
	},
	spawnCommandSession: async (_ctx: unknown, request: unknown) => {
		spawned.request = request;
		const runtime = spawned.runtime as FakeRuntime;
		if (spawned.exitAtMs !== undefined) setTimeout(() => runtime.exit(), spawned.exitAtMs);
		return { id: `bash_${++spawned.nextId}`, runtime };
	},
}));

type Exit = {
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
	readonly signal: string | null;
	readonly backend: "native";
};

class FakeRuntime {
	readonly session = {
		kill: vi.fn(),
		waitExit: () => this.exitPromise,
		onExit: (listener: () => void) => {
			if (this.exited) queueMicrotask(listener);
			else this.exitListeners.add(listener);
			return () => this.exitListeners.delete(listener);
		},
	};
	readonly backend = "native";
	readonly outputListeners = new Set<(chunk: string) => void>();
	readonly exitListeners = new Set<() => void>();
	readonly exitPromise: Promise<void>;
	private resolveExit!: () => void;
	private output = "";
	private consumed = 0;
	exited = false;
	exitResult: Exit | null = null;
	readDeltaCalls = 0;
	nextDeltaDroppedChars = 0;

	constructor() {
		this.exitPromise = new Promise<void>((resolve) => {
			this.resolveExit = resolve;
		});
	}

	emit(text: string): void {
		this.output += text;
		for (const listener of this.outputListeners) listener(text);
	}

	exit(exit: Partial<Exit> = {}): void {
		if (this.exited) return;
		this.exited = true;
		this.exitResult = {
			exitCode: exit.exitCode ?? 0,
			timedOut: exit.timedOut ?? false,
			cancelled: exit.cancelled ?? false,
			signal: exit.signal ?? null,
			backend: "native",
		};
		for (const listener of this.exitListeners) listener();
		this.exitListeners.clear();
		this.resolveExit();
	}

	onOutput(listener: (chunk: string) => void): () => void {
		this.outputListeners.add(listener);
		return () => this.outputListeners.delete(listener);
	}

	readDelta(): { text: string; droppedChars: number } {
		this.readDeltaCalls += 1;
		const text = this.output.slice(this.consumed);
		this.consumed = this.output.length;
		const droppedChars = this.nextDeltaDroppedChars;
		this.nextDeltaDroppedChars = 0;
		return { text, droppedChars };
	}

	fullOutput(): string {
		return this.output;
	}
}

function firstText(result: TerminalToolResult): string {
	return result.content.map((block) => block.text).join("\n");
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function setup(options: { safeWaitSeconds?: number; timeoutAction?: "background" | "kill" } = {}) {
	const runtime = new FakeRuntime();
	const backgroundExit = vi.fn();
	const manager = {
		get: vi.fn(() => runtime as unknown as TerminalRuntimeSession),
		stop: vi.fn(async () => true),
	} as unknown as TerminalManager;
	const ctx = {
		manager,
		cwd: "/fixture",
		defaultCols: 120,
		defaultRows: 40,
		getEnv: () => ({}),
		timeoutAction: options.timeoutAction ?? "background",
		getSessionContext: () =>
			({
				getPromptCacheSafeWaitSeconds: () => options.safeWaitSeconds,
			}) as ExtensionContext,
		onBackgroundExit: backgroundExit,
	} as TerminalToolContext;
	spawned.runtime = runtime;
	return { runtime, backgroundExit, manager, ctx, bash: createPtyBashTool(ctx), output: createBashOutputTool(ctx) };
}

beforeEach(() => {
	vi.useFakeTimers();
	spawned.nextId = 0;
	spawned.runtime = undefined;
	spawned.request = undefined;
	spawned.exitAtMs = undefined;
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("terminal bash foreground cache-deadline auto-detach", () => {
	it("keeps native foreground behavior when no cache-safe budget is available", async () => {
		const { bash, runtime } = setup();
		const execution = bash.execute("no-budget", { command: "echo done", timeout: 10 });
		await flushMicrotasks();
		runtime.emit("done\n");
		runtime.exit();

		const result = await execution;
		expect(firstText(result)).toBe("done");
		expect(result.details).toEqual({ status: "completed" });
		expect(runtime.readDeltaCalls).toBe(0);
	});

	it("does not auto-detach when timeoutAction is kill", async () => {
		const { bash, runtime } = setup({ safeWaitSeconds: 5, timeoutAction: "kill" });
		const execution = bash.execute("kill-policy", { command: "sleep", timeout: 10 });
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(runtime.exited).toBe(false);
		expect(runtime.readDeltaCalls).toBe(0);

		runtime.exit({ timedOut: true, exitCode: 124 });
		const result = await execution;
		expect(result.isError).toBe(true);
		expect(firstText(result)).toBe("Command timed out after 10 seconds");
		expect(result.details).toBeUndefined();
	});

	it("keeps native foreground behavior when the configured timeout equals the budget", async () => {
		const { bash, runtime } = setup({ safeWaitSeconds: 5 });
		const execution = bash.execute("equal-budget", { command: "echo exact", timeout: 5 });
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(runtime.readDeltaCalls).toBe(0);

		runtime.emit("exact\n");
		runtime.exit();
		const result = await execution;
		expect(firstText(result)).toBe("exact");
		expect(result.details).toEqual({ status: "completed" });
	});

	it("returns the exact completed result when a command exits before the budget", async () => {
		const { bash, runtime } = setup({ safeWaitSeconds: 5 });
		const execution = bash.execute("early-exit", { command: "echo early", timeout: 10 });
		await flushMicrotasks();
		runtime.emit("early\n");
		runtime.exit();

		const result = await execution;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(firstText(result)).toBe("early");
		expect(result.details).toEqual({ status: "completed" });
		expect(runtime.readDeltaCalls).toBe(0);
	});

	it("linearizes an exit exactly at D ahead of detachment", async () => {
		spawned.exitAtMs = 5_000;
		const { bash, runtime } = setup({ safeWaitSeconds: 5 });
		const execution = bash.execute("exit-at-deadline", { command: "echo same-tick", timeout: 10 });
		await flushMicrotasks();
		runtime.emit("same-tick\n");
		await vi.advanceTimersByTimeAsync(5_000);

		const result = await execution;
		expect(firstText(result)).toBe("same-tick");
		expect(result.details).toEqual({ status: "completed" });
		expect(runtime.readDeltaCalls).toBe(0);
	});

	it("auto-detaches a still-running finite-timeout command, preserves T, and sweeps after its native grace", async () => {
		const { bash, runtime, manager, backgroundExit } = setup({ safeWaitSeconds: 5 });
		const execution = bash.execute("detach", { command: "sleep", timeout: 10 });
		await flushMicrotasks();
		runtime.emit("READY\n");
		runtime.nextDeltaDroppedChars = 3;
		await vi.advanceTimersByTimeAsync(5_000);

		const result = await execution;
		expect(spawned.request).toMatchObject({ timeoutMs: 10_000 });
		expect(result).toEqual({
			content: [
				{
					type: "text",
					text:
						"Command is still running; auto-detached to background with ID: bash_1 (not killed; the original 10s timeout still applies).\n\nPartial output:\nREADY\n\nContinue other work; completion will be reported automatically with exit status and output tail. Use bash_output({ bash_id: \"bash_1\" }) only to peek at new output. monitor cannot attach to this session; use it for future event-driven launches. Use kill_bash({ bash_id: \"bash_1\" }) to stop this session.",
				},
			],
			details: { bash_id: "bash_1", background: true, auto_detached: true, status: "running", droppedChars: 3 },
			isError: undefined,
		});
		expect(runtime.readDeltaCalls).toBe(1);
		expect(runtime.session.kill).not.toHaveBeenCalled();
		expect(backgroundExit).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(10_000);
		expect(manager.stop).toHaveBeenCalledWith("bash_1");
	});

	it("uses the no-timeout parenthetical and keeps the delta cursor continuous after detachment", async () => {
		const { bash, output, runtime } = setup({ safeWaitSeconds: 5 });
		const execution = bash.execute("no-timeout", { command: "wait forever" });
		await flushMicrotasks();
		runtime.emit("BEFORE\n");
		await vi.advanceTimersByTimeAsync(5_000);

		const detached = await execution;
		expect(firstText(detached)).toBe(
			"Command is still running; auto-detached to background with ID: bash_1 (not killed; it will run until exit or kill_bash).\n\nPartial output:\nBEFORE\n\nContinue other work; completion will be reported automatically with exit status and output tail. Use bash_output({ bash_id: \"bash_1\" }) only to peek at new output. monitor cannot attach to this session; use it for future event-driven launches. Use kill_bash({ bash_id: \"bash_1\" }) to stop this session.",
		);
		expect(runtime.readDeltaCalls).toBe(1);

		runtime.emit("AFTER\n");
		const peek = await output.execute("peek", { bash_id: "bash_1" });
		expect(firstText(peek)).toBe("status: running\nAFTER");
		expect(firstText(peek)).not.toContain("BEFORE");
		expect(firstText(peek)).not.toContain("auto-detached");
		expect(runtime.readDeltaCalls).toBe(2);
	});

	it("ignores an abort after the detach commit and notifies once when the detached session exits", async () => {
		const controller = new AbortController();
		const { bash, runtime, backgroundExit } = setup({ safeWaitSeconds: 5 });
		const execution = bash.execute("abort-after-detach", { command: "sleep", timeout: 10 }, controller.signal);
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(5_000);
		await execution;

		controller.abort();
		expect(runtime.session.kill).not.toHaveBeenCalled();
		runtime.exit({ cancelled: true, exitCode: null, signal: "SIGKILL" });
		await flushMicrotasks();
		expect(backgroundExit).toHaveBeenCalledTimes(1);
		expect(backgroundExit).toHaveBeenCalledWith("bash_1", runtime);
	});

	it("linearizes an abort exactly at D ahead of detachment", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5_000);
		const { bash, runtime } = setup({ safeWaitSeconds: 5 });
		const execution = bash.execute("abort-at-deadline", { command: "sleep", timeout: 10 }, controller.signal);
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(runtime.session.kill).toHaveBeenCalledWith("SIGKILL");
		expect(runtime.readDeltaCalls).toBe(0);

		runtime.exit({ cancelled: true, exitCode: null, signal: "SIGKILL" });
		const result = await execution;
		expect(result.isError).toBe(true);
		expect(firstText(result)).toBe("Command aborted");
	});
});
