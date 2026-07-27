import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../../src/index.ts";
import { createHarness } from "../suite/harness.ts";

function makeTool(name: string) {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: `${name}-ran` }], details: {} }),
	};
}

async function harnessWith(factory: (pi: ExtensionAPI) => void) {
	let api: ExtensionAPI | undefined;
	const extensionFactories: ExtensionFactory[] = [
		(pi) => {
			api = pi;
			factory(pi);
		},
	];
	const harness = await createHarness({ extensionFactories });
	return { ...harness, api: api as ExtensionAPI };
}

describe("lazy tool activation through executeTool", () => {
	it("activates an eligible inactive tool and runs it", async () => {
		const harness = await harnessWith((pi) => {
			pi.registerTool(makeTool("mcp_fx_click"));
			pi.registerLazyToolActivator((toolName) => {
				if (toolName !== "mcp_fx_click") return false;
				pi.setActiveTools([...pi.getActiveTools(), toolName]);
				return true;
			});
		});

		try {
			harness.session.setActiveToolsByName(["read"]);
			expect(harness.session.getActiveToolNames()).not.toContain("mcp_fx_click");

			const result = await harness.api.executeTool("mcp_fx_click", {});

			expect(JSON.stringify(result.content)).toContain("mcp_fx_click-ran");
			expect(harness.session.getActiveToolNames()).toContain("mcp_fx_click");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps inactive_tool when the activator declines", async () => {
		const harness = await harnessWith((pi) => {
			pi.registerTool(makeTool("gated_tool"));
			pi.registerLazyToolActivator(() => false);
		});

		try {
			harness.session.setActiveToolsByName(["read"]);
			await expect(harness.api.executeTool("gated_tool", {})).rejects.toMatchObject({ code: "inactive_tool" });
			expect(harness.session.getActiveToolNames()).not.toContain("gated_tool");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps unknown_tool for a never-registered name", async () => {
		const harness = await harnessWith((pi) => {
			pi.registerLazyToolActivator(() => true);
		});

		try {
			harness.session.setActiveToolsByName(["read"]);
			await expect(harness.api.executeTool("never_registered", {})).rejects.toMatchObject({ code: "unknown_tool" });
			expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps inactive_tool when no activator is registered", async () => {
		const harness = await harnessWith((pi) => {
			pi.registerTool(makeTool("plain_tool"));
		});

		try {
			harness.session.setActiveToolsByName(["read"]);
			await expect(harness.api.executeTool("plain_tool", {})).rejects.toMatchObject({ code: "inactive_tool" });
		} finally {
			harness.cleanup();
		}
	});
});
