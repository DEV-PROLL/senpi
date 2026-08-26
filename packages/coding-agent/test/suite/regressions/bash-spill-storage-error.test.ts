import { beforeEach, describe, expect, it, vi } from "vitest";

const spillState = vi.hoisted(() => {
	const createdStreams: Array<{ readonly destroyed: boolean }> = [];
	let emitQuotaError = true;
	const pendingEmissions: Array<() => void> = [];
	const unhandledErrors: Error[] = [];
	const quotaError = Object.assign(new Error("unknown error, write"), {
		code: "EDQUOT",
		errno: -122,
		syscall: "write",
	});
	return {
		createdStreams,
		get emitQuotaError() {
			return emitQuotaError;
		},
		set emitQuotaError(value: boolean) {
			emitQuotaError = value;
		},
		pendingEmissions,
		quotaError,
		unhandledErrors,
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const { Writable } = await import("node:stream");
	return {
		...actual,
		createWriteStream: () => {
			let emitted = false;
			const stream = new Writable({
				write(_chunk, _encoding, callback) {
					callback();
					if (emitted || !spillState.emitQuotaError) return;
					emitted = true;
					queueMicrotask(() => {
						for (const resolve of spillState.pendingEmissions.splice(0)) resolve();
						if (stream.listenerCount("error") === 0) {
							spillState.unhandledErrors.push(spillState.quotaError);
							return;
						}
						stream.emit("error", spillState.quotaError);
					});
				},
			});
			spillState.createdStreams.push(stream);
			return stream;
		},
	};
});

import { executeBashWithOperations } from "../../../src/core/bash-executor.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import { OutputAccumulator } from "../../../src/core/tools/output-accumulator.ts";
import { DEFAULT_MAX_BYTES } from "../../../src/core/tools/truncate.ts";

function nextSpillErrorEmission(): Promise<void> {
	return new Promise((resolve) => spillState.pendingEmissions.push(resolve));
}

describe("bash spill storage errors", () => {
	beforeEach(() => {
		spillState.createdStreams.length = 0;
		spillState.emitQuotaError = true;
		spillState.pendingEmissions.length = 0;
		spillState.unhandledErrors.length = 0;
	});

	it("routes a quota failure through executeBashWithOperations instead of an unhandled stream error", async () => {
		const errorEmitted = nextSpillErrorEmission();
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
				await errorEmitted;
				return { exitCode: 0 };
			},
		};

		const execution = executeBashWithOperations("large output", process.cwd(), operations);

		await expect(execution).rejects.toBe(spillState.quotaError);
		expect(spillState.unhandledErrors).toEqual([]);
	});

	it("preserves a quota failure when cancellation races with command settlement", async () => {
		const errorEmitted = nextSpillErrorEmission();
		const controller = new AbortController();
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
				await errorEmitted;
				controller.abort();
				return { exitCode: 0 };
			},
		};

		const execution = executeBashWithOperations("cancelled large output", process.cwd(), operations, {
			signal: controller.signal,
		});

		await expect(execution).rejects.toBe(spillState.quotaError);
		expect(spillState.unhandledErrors).toEqual([]);
	});

	it("closes the spill stream when decoder flush delivery throws", async () => {
		spillState.emitQuotaError = false;
		const callbackError = new Error("consumer failed on decoder flush");
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
				onData(Buffer.from([0xe2]));
				return { exitCode: 0 };
			},
		};

		const execution = executeBashWithOperations("partial utf8 output", process.cwd(), operations, {
			onChunk: (chunk) => {
				if (chunk === "\ufffd") throw callbackError;
			},
		});

		await expect(execution).rejects.toBe(callbackError);
		expect(spillState.createdStreams).toHaveLength(1);
		expect(spillState.createdStreams[0]?.destroyed).toBe(true);
	});

	it("routes a quota failure through OutputAccumulator.closeTempFile", async () => {
		const errorEmitted = nextSpillErrorEmission();
		const output = new OutputAccumulator({ maxBytes: 1 });

		output.append(Buffer.from("too large"));
		await errorEmitted;

		await expect(output.closeTempFile()).rejects.toBe(spillState.quotaError);
		expect(spillState.unhandledErrors).toEqual([]);
	});
});
