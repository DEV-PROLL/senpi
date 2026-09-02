import { afterEach, describe, expect, it, vi } from "vitest";
import registerTerminalExtension from "../../src/core/extensions/builtin/terminal/index.ts";
import { MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { createHarness, type Harness } from "./harness.ts";

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((part) => part.type === "text")?.text ?? "";
}

describe("terminal monitor external resume", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("resumes muted monitors for user input but not extension input", async () => {
		const register = vi.spyOn(MonitorRegistry.prototype, "register");
		const harness = await createHarness({ extensionFactories: [registerTerminalExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const started = await harness.session.executeTool("monitor", {
			description: "external resume test",
			command: "sleep 30",
			persistent: true,
		});
		const bashId = /bash_\d+/.exec(resultText(started))?.[0];
		if (!bashId) throw new Error("Monitor did not return a bash id");
		const registry = register.mock.instances[0] as MonitorRegistry | undefined;
		if (!registry) throw new Error("Monitor registry was not captured");

		try {
			registry.pause([bashId]);
			expect(registry.snapshot()).toContainEqual({
				id: bashId,
				paused: true,
				description: "external resume test",
				startedAtMs: expect.any(Number),
			});

			await harness
				.getExtensionRunner()
				.emitInput("generated", undefined, "extension", undefined, "extension-input");
			expect(registry.snapshot()).toContainEqual({
				id: bashId,
				paused: true,
				description: "external resume test",
				startedAtMs: expect.any(Number),
			});

			await harness.getExtensionRunner().emitInput("hi", undefined, "interactive", undefined, "user-input");
			expect(registry.snapshot()).toContainEqual({
				id: bashId,
				paused: false,
				description: "external resume test",
				startedAtMs: expect.any(Number),
			});
		} finally {
			await harness.session.executeTool("kill_bash", { bash_id: bashId });
			register.mockRestore();
		}
	});
});
