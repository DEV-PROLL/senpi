import { link, mkdtemp, open, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { vi } from "vitest";

const fsState = vi.hoisted(() => ({
	hangOpen: false,
	openStarted: undefined as (() => void) | undefined,
	onOpen: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			if (fsState.hangOpen) {
				fsState.openStarted?.();
				return await new Promise<never>(() => {});
			}
			const handle = await actual.open(...args);
			await fsState.onOpen?.();
			return handle;
		},
	};
});

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import {
	type MonitorEvent,
	MonitorRegistry,
	type MonitorSummaryEvent,
} from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import { createKillBashTool } from "../../src/core/extensions/builtin/terminal/tools/kill-bash.ts";
import {
	createMonitorTool,
	type MonitorInput,
	monitorSchema,
} from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

function summaryEvent(event: MonitorEvent): MonitorSummaryEvent {
	if (event.type !== "summary") throw new Error("Expected a monitor summary event");
	return event;
}

class EventSink {
	readonly events: MonitorEvent[] = [];
	readonly #listeners = new Set<(event: MonitorEvent) => void>();

	push(event: MonitorEvent): void {
		this.events.push(event);
		for (const listener of this.#listeners) listener(event);
	}

	waitFor(predicate: (event: MonitorEvent) => boolean, label: string): Promise<MonitorEvent> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#listeners.delete(listener);
				reject(new Error(`Timed out waiting for ${label}`));
			}, 5000);
			const listener = (event: MonitorEvent) => {
				if (!predicate(event)) return;
				clearTimeout(timeout);
				this.#listeners.delete(listener);
				resolve(event);
			};
			this.#listeners.add(listener);
		});
	}
}

describe("terminal monitor tool", () => {
	let manager: TerminalManager;
	let ctx: TerminalToolContext;
	let sink: EventSink;
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;

	beforeEach(() => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		manager = new TerminalManager();
		sink = new EventSink();
		ctx = {
			manager,
			cwd: process.cwd(),
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
			onMonitorEvent: (event) => sink.push(event),
		};
	});

	afterEach(async () => {
		await manager.teardown();
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});

	it("exposes a flat object schema so providers' legacy object conversion keeps every field", () => {
		const shape = monitorSchema as unknown as { type?: string; properties?: Record<string, unknown> };
		expect(shape.type).toBe("object");
		const properties = Object.keys(shape.properties ?? {});
		for (const field of [
			"action",
			"description",
			"command",
			"path",
			"event",
			"filter",
			"timeout_ms",
			"persistent",
			"bash_id",
		]) {
			expect(properties).toContain(field);
		}
	});

	it("rejects a create call missing description and command instead of spawning", async () => {
		const tool = createMonitorTool(ctx);
		const result = await tool.execute("monitor-empty", {} as MonitorInput);
		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain("description");
		expect(firstText(result)).toContain("command");
	});

	it("rejects rearm without bash_id", async () => {
		const tool = createMonitorTool(ctx);
		const result = await tool.execute("monitor-rearm-missing", { action: "rearm" } as MonitorInput);
		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain("bash_id");
	});

	it("returns a bash_id immediately and emits complete stdout lines in order before its summary", async () => {
		const tool = createMonitorTool(ctx);
		const summary = sink.waitFor((event) => event.type === "summary", "monitor completion");

		const result = await tool.execute("monitor-create", {
			description: "line order",
			command: "printf 'ONE\\nTWO\\n'",
		});

		const bashId = /ID: (bash_\d+)/.exec(firstText(result))?.[1];
		expect(bashId).toBeDefined();
		expect(manager.get(bashId!)).not.toBeNull();
		await summary;
		expect(sink.events.map((event) => (event.type === "line" ? event.line : event.summary))).toEqual([
			"ONE",
			"TWO",
			expect.stringContaining("completed"),
		]);
	});

	it("filters monitor events without removing non-matching terminal output from peek history", async () => {
		const tool = createMonitorTool(ctx);
		const summary = sink.waitFor((event) => event.type === "summary", "filtered completion");
		const result = await tool.execute("monitor-filter", {
			description: "filtered",
			command: "printf 'KEEP_ONE\\nDROP\\nKEEP_TWO\\n'",
			filter: "^KEEP",
		});
		const bashId = /ID: (bash_\d+)/.exec(firstText(result))?.[1];
		if (!bashId) throw new Error("Monitor did not return a bash_id");

		await summary;
		expect(sink.events.filter((event) => event.type === "line").map((event) => event.line)).toEqual([
			"KEEP_ONE",
			"KEEP_TWO",
		]);
		expect(manager.get(bashId)?.fullOutput()).toContain("DROP");
	});

	it("ends a timed watch and leaves persistent watches alive past their timeout", async () => {
		const tool = createMonitorTool(ctx);
		const timedOut = sink.waitFor(
			(event) => event.type === "summary" && event.description === "timed",
			"timeout summary",
		);
		const timedResult = await tool.execute("monitor-timeout", {
			description: "timed",
			command: "sleep 30",
			timeout_ms: 50,
		});
		expect(firstText(timedResult)).toMatch(/ID: bash_\d+/);
		expect(summaryEvent(await timedOut).summary).toContain("timed_out");

		const persistent = sink.waitFor(
			(event) => event.type === "summary" && event.description === "persistent",
			"persistent completion",
		);
		await tool.execute("monitor-persistent", {
			description: "persistent",
			command: "sleep 0.05; printf 'PERSISTED\\n'",
			timeout_ms: 10,
			persistent: true,
		});
		expect(summaryEvent(await persistent).summary).toContain("completed");
	});

	it("shares the bash registry with kill_bash and treats rearm of a live monitor as a no-op", async () => {
		const tool = createMonitorTool(ctx);
		const ended = sink.waitFor((event) => event.type === "summary", "killed monitor summary");
		const started = await tool.execute("monitor-live", { description: "live", command: "sleep 30" });
		const bashId = /ID: (bash_\d+)/.exec(firstText(started))?.[1];
		if (!bashId) throw new Error("Monitor did not return a bash_id");

		const rearm = await tool.execute("monitor-rearm", { action: "rearm", bash_id: bashId });
		expect(firstText(rearm)).toContain("not paused");
		const killed = await createKillBashTool(ctx).execute("kill-monitor", { bash_id: bashId });
		expect(firstText(killed)).toContain(`Killed ${bashId}`);
		expect(summaryEvent(await ended).summary).toContain("killed");
	});

	it("emits a final summary when a wake-budget-paused monitor exits", async () => {
		const registry = new MonitorRegistry((event) => sink.push(event));
		const tool = createMonitorTool({ ...ctx, monitorRegistry: registry });
		const ended = sink.waitFor((event) => event.type === "summary", "paused monitor completion");
		const started = await tool.execute("monitor-paused-exit", { description: "paused exit", command: "sleep 30" });
		const bashId = /ID: (bash_\d+)/.exec(firstText(started))?.[1];
		if (!bashId) throw new Error("Monitor did not return a bash_id");

		registry.pauseAll();
		await createKillBashTool(ctx).execute("kill-paused", { bash_id: bashId });
		expect(summaryEvent(await ended).summary).toContain("killed");
	});

	it("rearms a wake-budget-paused monitor and notifies the session delivery controller", async () => {
		let rearmedId: string | undefined;
		const registry = new MonitorRegistry((event) => sink.push(event));
		const tool = createMonitorTool({ ...ctx, monitorRegistry: registry, onMonitorRearmed: (id) => (rearmedId = id) });
		const ended = sink.waitFor((event) => event.type === "summary", "rearmed monitor completion");
		const started = await tool.execute("monitor-paused", { description: "paused", command: "sleep 30" });
		const bashId = /ID: (bash_\d+)/.exec(firstText(started))?.[1];
		if (!bashId) throw new Error("Monitor did not return a bash_id");

		expect(registry.pauseAll()).toEqual([bashId]);
		const rearmed = await tool.execute("monitor-resume", { action: "rearm", bash_id: bashId });
		expect(firstText(rearmed)).toContain("re-armed");
		expect(rearmedId).toBe(bashId);
		await createKillBashTool(ctx).execute("kill-rearmed", { bash_id: bashId });
		expect(summaryEvent(await ended).summary).toContain("killed");
	});

	it("resolves the session-scoped monitor registry when execution begins", async () => {
		let registry = new MonitorRegistry(() => {});
		const liveSink = new EventSink();
		const tool = createMonitorTool({
			...ctx,
			get monitorRegistry() {
				return registry;
			},
		});
		registry = new MonitorRegistry((event) => liveSink.push(event));
		const summary = liveSink.waitFor((event) => event.type === "summary", "session-scoped completion");

		await tool.execute("monitor-session-registry", {
			description: "session registry",
			command: "printf 'CURRENT\\n'",
		});

		expect(summaryEvent(await summary).summary).toContain("completed");
	});

	it("fires one native create watch event", async () => {
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		const registry = new MonitorRegistry((event) => sink.push(event));
		try {
			const tool = createMonitorTool({ ...ctx, monitorRegistry: registry });
			const line = sink.waitFor((event) => event.type === "line", "file create");
			const started = await tool.execute("file-create", {
				description: "artifact",
				path: join(root, "artifact"),
			} as MonitorInput);
			const id = /ID: (watch_\d+)/.exec(firstText(started))?.[1];
			expect(id).toMatch(/^watch_/);
			await writeFile(join(root, "artifact"), "created");
			expect((await line).type).toBe("line");
		} finally {
			registry.dispose();
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("fails closed when an approved symlink parent is retargeted after activation", async () => {
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		const internal = await mkdtemp(join(process.cwd(), ".native-internal-"));
		const external = await mkdtemp(join(process.cwd(), ".native-external-"));
		const registry = new MonitorRegistry((event) => sink.push(event));
		try {
			const link = join(root, "parent");
			const requested = join(link, "artifact");
			await symlink(internal, link, "dir");
			await registry.registerFile({
				description: "drift",
				path: requested,
				event: "create",
				timeoutMs: 5000,
				cwd: root,
			});
			const summary = sink.waitFor(
				(event) => event.type === "summary" && event.description === "drift",
				"drift summary",
			);
			await rm(link);
			await symlink(external, link, "dir");
			await writeFile(join(external, "artifact"), "external");
			expect(summaryEvent(await summary).summary).toContain("monitored parent changed");
			expect(sink.events.filter((event) => event.type === "line")).toHaveLength(0);
		} finally {
			registry.dispose();
			await rm(root, { recursive: true, force: true });
			await rm(internal, { recursive: true, force: true });
			await rm(external, { recursive: true, force: true });
		}
	}, 15_000);

	it("aborts a pending registration when disposed and releases capacity", async () => {
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		const file = join(root, "artifact");
		const limited = new TerminalManager({ maxSessions: 1 });
		const registry = new MonitorRegistry(() => {}, { reserve: () => limited.reserve() });
		const openStarted = Promise.withResolvers<void>();
		fsState.hangOpen = true;
		fsState.openStarted = openStarted.resolve;
		try {
			await writeFile(file, "before");
			const registration = registry.registerFile({
				description: "pending",
				path: file,
				event: "modify",
				timeoutMs: 5000,
				cwd: root,
			});
			await openStarted.promise;
			registry.dispose();
			await expect(registration).rejects.toThrow(/cancelled|disposed/);
			const release = limited.reserve();
			expect(release).not.toBeNull();
			release?.();
		} finally {
			fsState.hangOpen = false;
			fsState.openStarted = undefined;
			registry.dispose();
			await limited.teardown();
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("aborts all pending registrations when stopAllFiles is called", async () => {
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		const file = join(root, "artifact");
		const limited = new TerminalManager({ maxSessions: 1 });
		const registry = new MonitorRegistry(() => {}, { reserve: () => limited.reserve() });
		const openStarted = Promise.withResolvers<void>();
		fsState.hangOpen = true;
		fsState.openStarted = openStarted.resolve;
		try {
			await writeFile(file, "before");
			const registration = registry.registerFile({
				description: "pending all",
				path: file,
				event: "modify",
				timeoutMs: 5000,
				cwd: root,
			});
			await openStarted.promise;
			await registry.stopAllFiles();
			await expect(
				Promise.race([
					registration,
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stop-all watchdog")), 100)),
				]),
			).rejects.toThrow(/cancelled|disposed/);
			const release = limited.reserve();
			expect(release).not.toBeNull();
			release?.();
		} finally {
			fsState.hangOpen = false;
			fsState.openStarted = undefined;
			fsState.onOpen = undefined;
			registry.dispose();
			await limited.teardown();
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("fails closed when the target is replaced after opening but before digest", async () => {
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		const outside = await mkdtemp(join(process.cwd(), ".native-outside-"));
		const target = join(root, "artifact");
		const registry = new MonitorRegistry((event) => sink.push(event));
		try {
			await writeFile(target, "before");
			await registry.registerFile({ description: "open race", path: target, event: "modify", timeoutMs: 5000, cwd: root });
			const summary = sink.waitFor((event) => event.type === "summary" && event.description === "open race", "open race summary");
			const external = join(outside, "secret");
			await writeFile(external, "external");
			let armed = true;
			fsState.onOpen = async () => {
				if (!armed) return;
				armed = false;
				await rm(target);
				await symlink(external, target);
			};
			await writeFile(target, "trigger");
			expect(summaryEvent(await summary).summary).toContain("target identity changed");
			expect(sink.events.filter((event) => event.type === "line")).toHaveLength(0);
		} finally {
			fsState.onOpen = undefined;
			registry.dispose();
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	}, 15_000);

	it("fails closed when an existing target is replaced by a different hardlink inode", async () => {
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		const registry = new MonitorRegistry((event) => sink.push(event));
		try {
			const target = join(root, "artifact");
			const replacement = join(root, "replacement");
			await writeFile(target, "before");
			await writeFile(replacement, "external");
			await registry.registerFile({ description: "hardlink swap", path: target, event: "modify", timeoutMs: 5000, cwd: root });
			const summary = sink.waitFor((event) => event.type === "summary" && event.description === "hardlink swap", "hardlink summary");
			await rm(target);
			await link(replacement, target);
			expect(summaryEvent(await summary).summary).toContain("target identity changed");
			expect(sink.events.filter((event) => event.type === "line")).toHaveLength(0);
		} finally {
			registry.dispose();
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("fails closed when a missing target is replaced with an external symlink", async () => {
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		const outside = await mkdtemp(join(process.cwd(), ".native-outside-"));
		const registry = new MonitorRegistry((event) => sink.push(event));
		try {
			const target = join(root, "artifact");
			await registry.registerFile({
				description: "create symlink",
				path: target,
				event: "create",
				timeoutMs: 5000,
				cwd: root,
			});
			const summary = sink.waitFor(
				(event) => event.type === "summary" && event.description === "create symlink",
				"create symlink summary",
			);
			const external = join(outside, "secret");
			await writeFile(external, "external");
			await symlink(external, target);
			expect(summaryEvent(await summary).summary).toContain("target identity changed");
			expect(sink.events.filter((event) => event.type === "line")).toHaveLength(0);
		} finally {
			registry.dispose();
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	}, 15_000);

	it("fails closed when an existing target is replaced with an external symlink", async () => {
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		const outside = await mkdtemp(join(process.cwd(), ".native-outside-"));
		const target = join(root, "artifact");
		const registry = new MonitorRegistry((event) => sink.push(event));
		try {
			await writeFile(target, "before");
			await registry.registerFile({
				description: "modify symlink",
				path: target,
				event: "modify",
				timeoutMs: 5000,
				cwd: root,
			});
			const summary = sink.waitFor(
				(event) => event.type === "summary" && event.description === "modify symlink",
				"modify symlink summary",
			);
			const external = join(outside, "secret");
			await writeFile(external, "external");
			await rm(target);
			await symlink(external, target);
			expect(summaryEvent(await summary).summary).toContain("target identity changed");
			expect(sink.events.filter((event) => event.type === "line")).toHaveLength(0);
		} finally {
			registry.dispose();
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	}, 15_000);

	it("fires one native modify watch event", async () => {
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		const file = join(root, "artifact");
		const registry = new MonitorRegistry((event) => sink.push(event));
		try {
			await writeFile(file, "before");
			const tool = createMonitorTool({ ...ctx, monitorRegistry: registry });
			const line = sink.waitFor((event) => event.type === "line", "file modify");
			await tool.execute("file-modify", { description: "artifact", path: file, event: "modify" } as MonitorInput);
			await writeFile(file, "after");
			expect((await line).type).toBe("line");
		} finally {
			registry.dispose();
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("holds native-watch capacity until the watch settles", async () => {
		const limited = new TerminalManager({ maxSessions: 1 });
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		const registry = new MonitorRegistry((event) => sink.push(event), { reserve: () => limited.reserve() });
		try {
			await registry.registerFile({
				description: "live",
				path: join(root, "artifact"),
				event: "create",
				timeoutMs: 5000,
				cwd: root,
			});
			expect(limited.reserve()).toBeNull();
			await registry.stopAllFiles();
			const released = limited.reserve();
			expect(released).not.toBeNull();
			released?.();
		} finally {
			registry.dispose();
			await limited.teardown();
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("shares capacity with terminal sessions", async () => {
		const limited = new TerminalManager({ maxSessions: 1 });
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		try {
			await limited.create("sh", {
				command: "sh",
				args: ["-c", "sleep 30"],
				cwd: root,
				cols: 80,
				rows: 24,
				env: { ...process.env },
			});
			const registry = new MonitorRegistry((event) => sink.push(event), { reserve: () => limited.reserve() });
			const result = await createMonitorTool({ ...ctx, manager: limited, monitorRegistry: registry }).execute(
				"full",
				{ description: "full", path: join(root, "artifact") } as MonitorInput,
			);
			expect(result.isError).toBe(true);
		} finally {
			await limited.teardown();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects invalid native watch paths", async () => {
		const tool = createMonitorTool({ ...ctx, monitorRegistry: new MonitorRegistry((event) => sink.push(event)) });
		const result = await tool.execute("bad-file", {
			description: "bad",
			path: join(process.cwd(), "missing-parent", "x"),
		} as MonitorInput);
		expect(result.isError).toBe(true);
	});

	it("cancels a native watch through kill_bash", async () => {
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		const registry = new MonitorRegistry((event) => sink.push(event));
		try {
			const tool = createMonitorTool({ ...ctx, monitorRegistry: registry });
			const started = await tool.execute("file-kill", {
				description: "artifact",
				path: join(root, "artifact"),
			} as MonitorInput);
			const id = /ID: (watch_\d+)/.exec(firstText(started))?.[1];
			expect(id).toBeDefined();
			const killed = await createKillBashTool({ ...ctx, monitorRegistry: registry }).execute("kill", {
				bash_id: id,
			});
			expect(firstText(killed)).toContain(`Killed ${id}`);
			expect(registry.snapshot()).toEqual([]);
		} finally {
			registry.dispose();
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("adds external-directory approval for native paths", () => {
		const requests = createBuiltinParserRegistry().parse("monitor", { path: "/tmp/secret/file" }, process.cwd());
		expect(requests.map((request) => request.permission)).toEqual(["read", "external_directory"]);
	});

	it("classifies missing descendants beneath external symlink parents as external", async () => {
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		const outside = await mkdtemp(join(process.cwd(), ".native-outside-"));
		try {
			const link = join(root, "link");
			await symlink(outside, link, "dir");
			const requests = createBuiltinParserRegistry().parse("monitor", { path: join(link, "not-yet-created") }, root);
			expect(requests.map((request) => request.permission)).toEqual(["read", "external_directory"]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("detects content changes even when the timestamp is restored", async () => {
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		const file = join(root, "artifact");
		const registry = new MonitorRegistry((event) => sink.push(event));
		try {
			await writeFile(file, "before");
			const original = await stat(file);
			await registry.registerFile({
				description: "artifact",
				path: file,
				event: "modify",
				timeoutMs: 5000,
				cwd: root,
			});
			const line = sink.waitFor((event) => event.type === "line", "timestamp-preserving modify");
			await writeFile(file, "after");
			await utimes(file, original.atime, original.mtime);
			await line;
			expect(sink.events.filter((event) => event.type === "line")).toHaveLength(1);
		} finally {
			registry.dispose();
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("detects a timestamp-preserving rewrite in the middle sample", async () => {
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		const file = join(root, "middle");
		const registry = new MonitorRegistry((event) => sink.push(event));
		try {
			await writeFile(file, Buffer.alloc(256 * 1024, 0x61));
			const original = await stat(file);
			await registry.registerFile({
				description: "middle",
				path: file,
				event: "modify",
				timeoutMs: 5000,
				cwd: root,
			});
			const line = sink.waitFor((event) => event.type === "line", "middle-sample modify");
			const changed = Buffer.alloc(2, 0x62);
			const handle = await open(file, "r+");
			try {
				await handle.write(changed, 0, changed.length, 128 * 1024);
			} finally {
				await handle.close();
			}
			await utimes(file, original.atime, original.mtime);
			await line;
		} finally {
			registry.dispose();
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("keeps large-file fingerprints bounded", async () => {
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		const file = join(root, "large");
		const registry = new MonitorRegistry((event) => sink.push(event));
		try {
			await writeFile(file, Buffer.alloc(64 * 1024 * 1024, 0x61));
			const before = process.memoryUsage().rss;
			await registry.registerFile({ description: "large", path: file, event: "modify", timeoutMs: 5000, cwd: root });
			const after = process.memoryUsage().rss;
			expect(after - before).toBeLessThan(32 * 1024 * 1024);
		} finally {
			registry.dispose();
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("reconciles exited terminal capacity for native watches", async () => {
		const limited = new TerminalManager({ maxSessions: 1 });
		const registry = new MonitorRegistry((event) => sink.push(event), { reserve: () => limited.reserve() });
		const root = await mkdtemp(join(process.cwd(), ".native-watch-"));
		try {
			const created = await limited.create("sh", {
				command: "sh",
				args: ["-c", "true"],
				cwd: root,
				cols: 80,
				rows: 24,
				env: { ...process.env },
			});
			await new Promise<void>((resolve) => {
				if (created.runtime.exited) resolve();
				else created.runtime.session.onExit(() => resolve());
			});
			await expect(
				registry.registerFile({
					description: "after exit",
					path: join(root, "new"),
					event: "create",
					timeoutMs: 1000,
					cwd: root,
				}),
			).resolves.toMatch(/^watch_/);
		} finally {
			await registry.stopAllFiles();
			await limited.teardown();
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("uses the same bash permission class as command execution", () => {
		const requests = createBuiltinParserRegistry().parse("monitor", { command: "rm -rf /tmp/monitor" }, "/tmp");
		expect(requests[0]?.permission).toBe("bash");
		expect(requests[0]?.patterns).toContain("rm");
	});
});
