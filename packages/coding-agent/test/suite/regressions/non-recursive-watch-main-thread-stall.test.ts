import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFsWatchEventSource,
	type WatchEventListener,
} from "../../../src/core/extensions/builtin/config-reload/watch-engine.ts";

const mocks = vi.hoisted(() => ({ fsWatch: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, watch: mocks.fsWatch };
});

class WatcherProbe extends EventEmitter {
	readonly close = vi.fn();
}

class WorkerProbe extends EventEmitter {
	readonly postMessage = vi.fn();
	readonly terminate = vi.fn(async () => 0);
}

describe("non-recursive watch main-thread stall", () => {
	beforeEach(() => {
		mocks.fsWatch.mockReset();
	});

	it("offloads non-recursive watch creation to the worker on darwin", () => {
		const worker = new WorkerProbe();
		const createRecursiveWorker = vi.fn(() => worker);
		const listener = vi.fn<WatchEventListener>();
		const source = createFsWatchEventSource(vi.fn(), {
			platform: "darwin",
			createRecursiveWorker,
		});

		// The watch engine subscribes per-directory with { recursive: false } since the
		// per-directory redesign; FSEvents stream creation blocks the main thread for
		// seconds under load, so it must run on the worker like recursive watches.
		const unsubscribe = source("/agent/extensions", listener, { recursive: false });
		worker.emit("message", { kind: "event", id: 1, eventType: "change", filename: "ext.ts" });

		expect(createRecursiveWorker).toHaveBeenCalledTimes(1);
		expect(worker.postMessage).toHaveBeenCalledWith({
			kind: "watch",
			id: 1,
			path: "/agent/extensions",
			recursive: false,
		});
		expect(mocks.fsWatch).not.toHaveBeenCalled();
		expect(listener).toHaveBeenCalledWith("change", "ext.ts");

		unsubscribe();
		expect(worker.terminate).toHaveBeenCalledTimes(1);
	});

	it("keeps every watch on direct fs.watch on windows", () => {
		const watcher = new WatcherProbe();
		mocks.fsWatch.mockReturnValue(watcher);
		const createRecursiveWorker = vi.fn(() => new WorkerProbe());
		const source = createFsWatchEventSource(vi.fn(), {
			platform: "win32",
			createRecursiveWorker,
		});

		const unsubscribe = source("/small-config-directory", vi.fn(), { recursive: false });

		expect(mocks.fsWatch).toHaveBeenCalledWith(
			"/small-config-directory",
			expect.objectContaining({ recursive: false }),
			expect.any(Function),
		);
		expect(createRecursiveWorker).not.toHaveBeenCalled();

		unsubscribe();
		expect(watcher.close).toHaveBeenCalledTimes(1);
	});
});
