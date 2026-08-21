import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { ExtensionRunner } from "../../../src/core/extensions/runner.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "../../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../../utilities.ts";

describe("permission system shutdown unhandled rejection", () => {
	let tempDir: string;
	const unhandledRejections: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandledRejections.push(reason);
	};

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-perm-rejection-"));
		unhandledRejections.length = 0;
		process.on("unhandledRejection", onUnhandled);
	});

	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("does not emit unhandledRejection when session_shutdown rejects pending permission requests", async () => {
		const extensionsResult = await createTestExtensionsResult([permissionSystemExtension], tempDir);
		const sessionManager = SessionManager.create(tempDir);
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir,
			sessionManager,
			modelRegistry,
			extensionsResult.eventBus,
		);

		runner.setFlagValue("permission-preset", "ask");
		await runner.emit({ type: "session_start", reason: "startup" });

		runner.setUIContext({
			select: async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
				return null;
			},
			input: async () => undefined,
		} as any);

		const toolCallPromise = runner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			input: { command: "echo hello" },
			toolCallId: "call-1",
		});

		await new Promise((resolve) => setTimeout(resolve, 20));
		await runner.emit({ type: "session_shutdown", reason: "quit" });

		const toolCallResult = await toolCallPromise;
		expect(toolCallResult).toEqual({
			block: true,
			reason: "The user rejected permission to use this specific tool call.",
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(unhandledRejections).toHaveLength(0);
	});
});
