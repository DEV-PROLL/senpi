import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../../../src/core/bash-executor.ts";
import { createLocalBashOperations } from "../../../src/core/tools/bash.ts";
import { DEFAULT_MAX_BYTES } from "../../../src/core/tools/truncate.ts";

const spillFiles = () => readdirSync(tmpdir()).filter((file) => file.startsWith("pi-bash-") && file.endsWith(".log"));

describe("bash local stream onChunk failures", () => {
	afterEach(() => {
		process.removeAllListeners("uncaughtException");
	});

	it("routes a real local stream onChunk string throw through spill cleanup", async () => {
		const before = spillFiles();
		const callbackError = "local onChunk failed";
		let uncaughtError: unknown;
		process.once("uncaughtException", (error) => {
			uncaughtError = error;
		});

		const execution = executeBashWithOperations(
			`head -c ${DEFAULT_MAX_BYTES + 1} /dev/zero | tr '\\0' x`,
			process.cwd(),
			createLocalBashOperations(),
			{
				onChunk: () => {
					throw callbackError;
				},
			},
		);

		await expect(execution).rejects.toBe(callbackError);
		expect(uncaughtError).toBeUndefined();
		expect(spillFiles()).toEqual(before);
	});
});
