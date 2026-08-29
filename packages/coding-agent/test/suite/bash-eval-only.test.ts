import { fauxAssistantMessage, fauxToolCall, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { runEvalSchema } from "../../../senpi-codemode/src/bridges/schema-bridge.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession, type ExtensionFactory } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("@code-yeongyu/senpi", async () => await import("../../src/index.ts"));
const { createExecuteTool } = await import("../../../senpi-codemode/src/extension/runtime-factory.ts");

function arm(harness: Harness, names = ["bash", "powershell"]): void {
	const session = harness.session as unknown as { _evalOnlyToolNames: ReadonlySet<string> };
	session._evalOnlyToolNames = new Set(names);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

async function createEvalHarness(options: { withEval?: boolean } = {}): Promise<{
	harness: Harness;
	observed: string[];
}> {
	const observed: string[] = [];
	const extensionFactory: ExtensionFactory = (pi) => {
		if (options.withEval !== false) {
			pi.registerTool({
				name: "eval",
				label: "Eval",
				description: "Evaluate code",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "eval" }], details: {} }),
			});
		}
		pi.on("tool_call", (event) => {
			if (event.toolName === "bash") observed.push(event.toolName);
		});
	};
	const harness = await createHarness({ extensionFactories: [extensionFactory] });
	return { harness, observed };
}

describe("experimental bash eval-only policy", () => {
	it("armed sessions hide bash and powershell and explain tool.bash(", async () => {
		const { harness } = await createEvalHarness();
		try {
			arm(harness);
			harness.session.setActiveToolsByName(["read", "bash", "powershell", "edit", "write"]);
			expect(harness.session.getActiveToolNames()).not.toContain("bash");
			expect(harness.session.getActiveToolNames()).not.toContain("powershell");
			expect(harness.session.systemPrompt).toContain("tool.bash(");
		} finally {
			harness.cleanup();
		}
	});

	it("executes hidden bash through hooks without reactivating it", async () => {
		const { harness, observed } = await createEvalHarness();
		try {
			arm(harness);
			harness.session.setActiveToolsByName(["read", "edit", "write"]);
			const result = await harness.session.executeTool(
				"bash",
				{ command: "echo hi" },
				{ activateInactiveTool: true },
			);
			expect(textOf(result)).toContain("hi");
			expect(observed).toEqual(["bash"]);
			expect(harness.session.getActiveToolNames()).not.toContain("bash");
		} finally {
			harness.cleanup();
		}
	});

	it("publishes the removed-tool hint for unknown tool calls", async () => {
		const { harness } = await createEvalHarness();
		try {
			arm(harness);
			harness.session.setActiveToolsByName(["read", "edit", "write"]);
			expect(harness.agent.removedToolHints.bash).toContain('tool.bash({ command: "..." })');
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("run bash");
			const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
			expect(toolResult && "content" in toolResult ? toolResult.content[0] : undefined).toMatchObject({
				text: expect.stringContaining('tool.bash({ command: "..." })'),
			});
		} finally {
			harness.cleanup();
		}
	});

	it("leaves the policy inert when eval is not registered", async () => {
		const { harness } = await createEvalHarness({ withEval: false });
		try {
			arm(harness);
			harness.session.setActiveToolsByName(["read", "bash", "edit", "write"]);
			expect(harness.session.getActiveToolNames()).toContain("bash");
			expect(textOf(await harness.session.executeTool("bash", { command: "echo hi" }))).toContain("hi");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps flag-off behavior unchanged", async () => {
		const { harness } = await createEvalHarness();
		try {
			const before = harness.session.systemPrompt;
			harness.session.setActiveToolsByName(["read", "bash", "edit", "write"]);
			expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
			expect(harness.session.systemPrompt).not.toContain("tool.bash(");
			expect(before).not.toContain("tool.bash(");
		} finally {
			harness.cleanup();
		}
	});

	it("SDK wiring arms the policy from experimental.bashEvalOnly", async () => {
		const settingsManager = SettingsManager.inMemory({ experimental: { bashEvalOnly: true } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "eval",
						label: "Eval",
						description: "Evaluate code",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "eval" }], details: {} }),
					});
				},
			],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(process.cwd()),
		});
		try {
			expect(session.getActiveToolNames()).not.toContain("bash");
			expect(session.systemPrompt).toContain("tool.bash(");
		} finally {
			session.dispose();
		}
	});

	it("getAllTools-backed eval schema still lists bash while the armed policy keeps it inactive", async () => {
		const { harness } = await createEvalHarness();
		try {
			arm(harness);
			harness.session.setActiveToolsByName(["read", "bash", "powershell", "edit", "write"]);
			const active = harness.session.getActiveToolNames();
			const allNames = harness.session.getAllTools().map((tool) => tool.name);
			expect(active).not.toContain("bash");
			expect(active).not.toContain("powershell");
			expect(allNames).toContain("bash");
			expect(allNames).toContain("powershell");
			const listed = runEvalSchema({}, { listTools: () => harness.session.getAllTools() });
			expect(listed).toEqual({
				tools: expect.arrayContaining(["bash", "powershell"]),
			});
			expect(runEvalSchema({ name: "bash" }, { listTools: () => harness.session.getAllTools() })).toMatchObject({
				name: "bash",
			});
		} finally {
			harness.cleanup();
		}
	});

	it("createExecuteTool wrapper runs bash without reactivating it", async () => {
		const observedActivations: string[] = [];
		let api: ExtensionAPI | undefined;
		const extensionFactory: ExtensionFactory = (pi) => {
			api = pi;
			pi.registerTool({
				name: "eval",
				label: "Eval",
				description: "Evaluate code",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "eval" }], details: {} }),
			});
			pi.registerLazyToolActivator((toolName) => {
				observedActivations.push(toolName);
				pi.setActiveTools([...pi.getActiveTools(), toolName]);
				return true;
			});
		};
		const harness = await createHarness({ extensionFactories: [extensionFactory] });
		try {
			arm(harness);
			harness.session.setActiveToolsByName(["read", "edit", "write"]);
			if (api === undefined) throw new Error("extension API was not captured");
			const runtime = api;
			const executeTool = createExecuteTool({
				executeTool: (toolName, params, options) => runtime.executeTool(toolName, params, options),
				getActiveTools: () => runtime.getActiveTools(),
				getAllTools: () => runtime.getAllTools(),
			});
			const result = await executeTool("bash", { command: "echo hi" });
			expect(textOf(result)).toContain("hi");
			expect(observedActivations).toEqual([]);
			expect(harness.session.getActiveToolNames()).not.toContain("bash");
		} finally {
			harness.cleanup();
		}
	});

	it("names each hidden tool in its own removed-tool hint", async () => {
		const { harness } = await createEvalHarness();
		try {
			arm(harness);
			harness.session.setActiveToolsByName(["read", "edit", "write"]);
			expect(harness.agent.removedToolHints.bash).toContain('tool.bash({ command: "..." })');
			expect(harness.agent.removedToolHints.powershell).toContain('tool.powershell({ command: "..." })');
			expect(harness.agent.removedToolHints.powershell).not.toContain("tool.bash(");
		} finally {
			harness.cleanup();
		}
	});
});
