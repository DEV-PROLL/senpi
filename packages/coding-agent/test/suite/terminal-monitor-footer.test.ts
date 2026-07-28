import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import {
	MonitorRegistry,
	type MonitorSnapshotEntry,
} from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { formatMonitorStatus } from "../../src/core/extensions/builtin/terminal/monitor-status.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import { createMonitorTool, type MonitorInput } from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

/** Resolves when the wrapped spy is called with a matching argument set. */
function deferredCall<TArgs extends unknown[]>(predicate: (...args: TArgs) => boolean) {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		setTimeout(() => rej(new Error("Timed out waiting for matching call")), 5000);
	});
	const handler = (...args: TArgs): void => {
		if (predicate(...args)) resolve?.();
	};
	return { promise, handler };
}

describe("formatMonitorStatus", () => {
	const entry = (id: string, description: string, paused = false): MonitorSnapshotEntry => ({
		id,
		description,
		paused,
	});

	it("returns undefined when nothing is monitored so the footer status clears", () => {
		expect(formatMonitorStatus([])).toBeUndefined();
	});

	it("names the single watched thing", () => {
		const text = formatMonitorStatus([entry("bash_1", "errors in deploy.log")]);
		expect(text).toContain("errors in deploy.log");
		expect(text).toContain("watching");
	});

	it("shows the count and elides long lists to a hard cap", () => {
		const text = formatMonitorStatus([
			entry("bash_1", "errors in deploy.log"),
			entry("bash_2", "integration test output on ci runner four"),
			entry("bash_3", "webpack rebuild"),
		]);
		expect(text).toBeDefined();
		expect(text).toContain("3");
		expect((text ?? "").length).toBeLessThanOrEqual(48);
		expect(text).toContain("…");
	});

	it("marks paused watches", () => {
		const all = formatMonitorStatus([entry("bash_1", "a", true), entry("bash_2", "b", true)]);
		expect(all).toContain("paused");
		const some = formatMonitorStatus([entry("bash_1", "a", true), entry("bash_2", "b")]);
		expect(some).toContain("1 paused");
	});
});

describe("MonitorRegistry change notification", () => {
	let manager: TerminalManager;
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;

	beforeEach(() => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		manager = new TerminalManager();
	});

	afterEach(async () => {
		await manager.teardown();
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});

	it("reports register, pause, rearm, settle, and dispose transitions", async () => {
		const snapshots: Array<readonly MonitorSnapshotEntry[]> = [];
		const settled = deferredCall<[readonly MonitorSnapshotEntry[]]>((snapshot) => snapshot.length === 0);
		const registry = new MonitorRegistry(() => {}, {
			onChange: (snapshot) => {
				snapshots.push(snapshot);
				settled.handler(snapshot);
			},
		});
		const ctx: TerminalToolContext = {
			manager,
			cwd: process.cwd(),
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
			monitorRegistry: registry,
		};
		const tool = createMonitorTool(ctx);
		const input: MonitorInput = { description: "quick echo watch", command: "printf 'one\\n'" };
		await tool.execute("call_1", input);

		expect(snapshots[0]).toEqual([
			{ id: expect.stringContaining("bash"), description: "quick echo watch", paused: false },
		]);
		await settled.promise;
		expect(snapshots.at(-1)).toEqual([]);
	});

	it("snapshots pause state through pauseAll and rearm", async () => {
		const snapshots: Array<readonly MonitorSnapshotEntry[]> = [];
		const registry = new MonitorRegistry(() => {}, { onChange: (snapshot) => snapshots.push(snapshot) });
		const ctx: TerminalToolContext = {
			manager,
			cwd: process.cwd(),
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
			monitorRegistry: registry,
		};
		const tool = createMonitorTool(ctx);
		const input: MonitorInput = { description: "long lived watch", command: "cat", persistent: true };
		await tool.execute("call_1", input);
		const registered = snapshots.at(-1);
		expect(registered?.[0]?.paused).toBe(false);

		registry.pauseAll();
		expect(snapshots.at(-1)?.[0]?.paused).toBe(true);
		expect(registry.snapshot()[0]?.paused).toBe(true);

		const id = registry.snapshot()[0]?.id ?? "";
		expect(registry.rearm(id)).toBe("rearmed");
		expect(snapshots.at(-1)?.[0]?.paused).toBe(false);

		registry.dispose();
		expect(snapshots.at(-1)).toEqual([]);
	});
});

describe("terminal extension footer status wiring", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;

	beforeEach(() => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
	});

	afterEach(() => {
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});

	it("publishes the monitors footer status while a watch is live and clears it on settle", async () => {
		type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
		const handlers = new Map<string, Handler[]>();
		const tools = new Map<string, { execute: (id: string, input: MonitorInput) => Promise<unknown> }>();
		let activeTools: string[] = [];
		const fakePi = {
			registerTool: (tool: { name: string; execute: (id: string, input: MonitorInput) => Promise<unknown> }) => {
				tools.set(tool.name, tool);
			},
			on: (event: string, handler: Handler) => {
				const existing = handlers.get(event) ?? [];
				existing.push(handler);
				handlers.set(event, existing);
			},
			sendUserMessage: () => {},
			getActiveTools: () => activeTools,
			setActiveTools: (next: string[]) => {
				activeTools = next;
			},
		} as unknown as ExtensionAPI;

		registerTerminalExtension(fakePi);

		const setStatus = vi.fn();
		const cleared = deferredCall<[string, string | undefined]>(
			(key, text) => key === "monitors" && text === undefined,
		);
		setStatus.mockImplementation((key: string, text: string | undefined) => cleared.handler(key, text));
		const ctx = {
			cwd: process.cwd(),
			ui: { setStatus, notify: () => {} },
		} as unknown as ExtensionContext;
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);

		const monitorTool = tools.get("monitor");
		expect(monitorTool).toBeDefined();
		await monitorTool?.execute("call_1", { description: "footer smoke watch", command: "printf 'line\\n'" });

		expect(setStatus).toHaveBeenCalledWith("monitors", expect.stringContaining("footer smoke watch"));
		await cleared.promise;
		expect(setStatus).toHaveBeenCalledWith("monitors", undefined);

		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
	});
});
