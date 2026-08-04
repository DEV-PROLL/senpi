import { describe, expect, it } from "vitest";
import { waitForSignalBeforeCompletion } from "./promise-test-utils.ts";

describe("waitForSignalBeforeCompletion", () => {
	it("returns when the signal arrives first", async () => {
		const operation = Promise.withResolvers<void>();
		const signal = Promise.withResolvers<void>();
		const waiting = waitForSignalBeforeCompletion(operation.promise, signal.promise, "stream start");

		signal.resolve();

		await expect(waiting).resolves.toBeUndefined();
		operation.reject(new Error("handled after signal"));
	});

	it("rethrows an operation rejection that arrives first", async () => {
		const operation = Promise.withResolvers<void>();
		const signal = Promise.withResolvers<void>();
		const waiting = waitForSignalBeforeCompletion(operation.promise, signal.promise, "stream start");
		const error = new Error("auth failed");

		operation.reject(error);

		await expect(waiting).rejects.toBe(error);
	});

	it("rejects when the operation completes before the signal", async () => {
		const operation = Promise.withResolvers<void>();
		const signal = Promise.withResolvers<void>();
		const waiting = waitForSignalBeforeCompletion(operation.promise, signal.promise, "stream start");

		operation.resolve();

		await expect(waiting).rejects.toThrow("Operation completed before stream start");
	});
});
