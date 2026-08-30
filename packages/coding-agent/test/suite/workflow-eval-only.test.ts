import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/sdk.ts";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("@code-yeongyu/senpi", async () => await import("../../src/index.ts"));

const WORKFLOW_HINT = 'tool.workflow({ action: "..." })';

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function armedNames(harness: Harness): string[] {
	const session = harness.session as unknown as { _evalOnlyToolNames?: ReadonlySet<string> };
	return [...(session._evalOnlyToolNames ?? [])];
}

interface WorkflowHarnessOptions {
	withEval?: boolean;
	settings?: Record<string, unknown>;
}

async function createWorkflowHarness(options: WorkflowHarnessOptions = {}): Promise<{
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
		// Stands in for the external extension that registers the real workflow tool.
		pi.registerTool({
			name: "workflow",
			label: "Workflow",
			description: "Run a workflow action",
			parameters: Type.Object({ action: Type.String() }),
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text", text: `workflow-ran:${params.action}` }],
				details: {},
			}),
		});
		pi.on("tool_call", (event) => {
			if (event.toolName === "workflow") observed.push(event.toolName);
		});
	};
	const harness = await createHarness({
		extensionFactories: [extensionFactory],
		...(options.settings ? { settings: options.settings } : {}),
	});
	return { harness, observed };
}

describe("experimental workflow eval-only policy", () => {
	it("hides workflow and explains tool.workflow( when the flag arms the session", async () => {
		// Given: a session whose settings enable experimental.workflowEvalOnly with eval registered
		const { harness } = await createWorkflowHarness({ settings: { experimental: { workflowEvalOnly: true } } });
		try {
			// When: the caller requests workflow among its active tools
			harness.session.setActiveToolsByName(["read", "workflow", "edit", "write"]);

			// Then: workflow is withheld and the prompt names its eval helper
			expect(harness.session.getActiveToolNames()).not.toContain("workflow");
			expect(harness.session.systemPrompt).toContain("tool.workflow({ action:");
		} finally {
			harness.cleanup();
		}
	});

	it("executes hidden workflow through hooks without reactivating it", async () => {
		// Given: an armed session with workflow left out of the active set
		const { harness, observed } = await createWorkflowHarness({
			settings: { experimental: { workflowEvalOnly: true } },
		});
		try {
			harness.session.setActiveToolsByName(["read", "edit", "write"]);

			// When: the eval bridge executes workflow directly
			const result = await harness.session.executeTool(
				"workflow",
				{ action: "deploy" },
				{ activateInactiveTool: true },
			);

			// Then: it runs through the registry, emits a tool_call, and stays inactive
			expect(textOf(result)).toContain("workflow-ran:deploy");
			expect(observed).toEqual(["workflow"]);
			expect(harness.session.getActiveToolNames()).not.toContain("workflow");
		} finally {
			harness.cleanup();
		}
	});

	it("publishes the workflow removed-tool hint for direct model calls", async () => {
		// Given: an armed session with workflow withheld
		const { harness } = await createWorkflowHarness({ settings: { experimental: { workflowEvalOnly: true } } });
		try {
			harness.session.setActiveToolsByName(["read", "edit", "write"]);
			expect(harness.agent.removedToolHints.workflow).toContain(WORKFLOW_HINT);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("workflow", { action: "deploy" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			// When: the model calls workflow directly anyway
			await harness.session.prompt("run workflow");

			// Then: the tool result redirects it to the eval helper
			const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
			expect(toolResult && "content" in toolResult ? toolResult.content[0] : undefined).toMatchObject({
				text: expect.stringContaining(WORKFLOW_HINT),
			});
		} finally {
			harness.cleanup();
		}
	});

	it("leaves the policy inert when eval is not registered", async () => {
		// Given: the flag is on but no eval tool exists to route through
		const { harness } = await createWorkflowHarness({
			withEval: false,
			settings: { experimental: { workflowEvalOnly: true } },
		});
		try {
			// When: workflow is requested as an active tool
			harness.session.setActiveToolsByName(["read", "workflow", "edit", "write"]);

			// Then: workflow stays directly available
			expect(harness.session.getActiveToolNames()).toContain("workflow");
			expect(textOf(await harness.session.executeTool("workflow", { action: "deploy" }))).toContain(
				"workflow-ran:deploy",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps flag-off behavior unchanged", async () => {
		// Given: a session with no experimental flags
		const { harness } = await createWorkflowHarness();
		try {
			const before = harness.session.systemPrompt;

			// When: workflow is requested as an active tool
			harness.session.setActiveToolsByName(["read", "workflow", "edit", "write"]);

			// Then: nothing is withheld and no eval guidance is appended
			expect(harness.session.getActiveToolNames()).toEqual(["read", "workflow", "edit", "write"]);
			expect(harness.session.systemPrompt).not.toContain("tool.workflow(");
			expect(before).not.toContain("tool.workflow(");
		} finally {
			harness.cleanup();
		}
	});

	it("arms only workflow when bashEvalOnly stays off", async () => {
		// Given: only the workflow flag is enabled
		const { harness } = await createWorkflowHarness({ settings: { experimental: { workflowEvalOnly: true } } });
		try {
			// When: shell tools and workflow are all requested
			harness.session.setActiveToolsByName(["read", "bash", "powershell", "workflow", "edit"]);

			// Then: shell tools stay directly available and no shell sentence is appended
			expect(armedNames(harness)).toEqual(["workflow"]);
			expect(harness.session.getActiveToolNames()).toContain("bash");
			expect(harness.session.getActiveToolNames()).toContain("powershell");
			expect(harness.session.getActiveToolNames()).not.toContain("workflow");
			expect(harness.session.systemPrompt).not.toContain("tool.bash(");
			expect(harness.session.systemPrompt).toContain("tool.workflow(");
		} finally {
			harness.cleanup();
		}
	});

	it("arms the union of both groups when both experimental flags are on", async () => {
		// Given: both experimental eval-only flags are enabled
		const { harness } = await createWorkflowHarness({
			settings: { experimental: { bashEvalOnly: true, workflowEvalOnly: true } },
		});
		try {
			// When: shell tools and workflow are all requested
			harness.session.setActiveToolsByName(["read", "bash", "powershell", "workflow", "edit"]);

			// Then: every group member is withheld and each hint names its own helper
			expect(new Set(armedNames(harness))).toEqual(new Set(["bash", "powershell", "workflow"]));
			const active = harness.session.getActiveToolNames();
			expect(active).toEqual(["read", "edit"]);
			expect(harness.agent.removedToolHints.bash).toContain('tool.bash({ command: "..." })');
			expect(harness.agent.removedToolHints.powershell).toContain('tool.powershell({ command: "..." })');
			expect(harness.agent.removedToolHints.workflow).toContain(WORKFLOW_HINT);
			expect(harness.session.systemPrompt).toContain("tool.bash(");
			expect(harness.session.systemPrompt).toContain("tool.powershell(");
			expect(harness.session.systemPrompt).toContain("tool.workflow(");
		} finally {
			harness.cleanup();
		}
	});
});
