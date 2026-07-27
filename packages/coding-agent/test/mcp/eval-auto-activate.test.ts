import { describe, expect, it, vi } from "vitest";
import {
	createLazyToolActivator,
	resolveLazyActivationTargets,
} from "../../src/core/extensions/builtin/mcp/expose/lazy-activate.ts";

const SEARCHABLE = [
	{ name: "mcp_computer_use_click", toolName: "click", server: "computer_use" },
	{ name: "mcp_computer_use_batch", toolName: "batch", server: "computer_use" },
] as const;

describe("resolveLazyActivationTargets", () => {
	it("selects a searchable tool that is registered but inactive", () => {
		expect(
			resolveLazyActivationTargets(["mcp_computer_use_click"], {
				searchable: SEARCHABLE,
				active: ["read", "bash"],
			}),
		).toEqual(["mcp_computer_use_click"]);
	});

	it("skips a tool that is already active", () => {
		expect(
			resolveLazyActivationTargets(["mcp_computer_use_click"], {
				searchable: SEARCHABLE,
				active: ["read", "mcp_computer_use_click"],
			}),
		).toEqual([]);
	});

	it("refuses a tool outside the searchable catalog", () => {
		expect(resolveLazyActivationTargets(["look_at"], { searchable: SEARCHABLE, active: ["read"] })).toEqual([]);
	});

	it("refuses an unknown tool", () => {
		expect(resolveLazyActivationTargets(["nope"], { searchable: SEARCHABLE, active: ["read"] })).toEqual([]);
	});

	it("coalesces several names into one deduplicated batch", () => {
		expect(
			resolveLazyActivationTargets(
				["mcp_computer_use_click", "mcp_computer_use_click", "mcp_computer_use_batch", "look_at"],
				{ searchable: SEARCHABLE, active: ["read"] },
			),
		).toEqual(["mcp_computer_use_click", "mcp_computer_use_batch"]);
	});
});

describe("createLazyToolActivator", () => {
	it("routes activation through the tier-B activate path exactly once", () => {
		const activate = vi.fn();
		const activator = createLazyToolActivator({
			getSearchable: () => SEARCHABLE,
			getActiveTools: () => ["read"],
			activate,
		});

		expect(activator("mcp_computer_use_click")).toBe(true);
		expect(activate).toHaveBeenCalledTimes(1);
		expect(activate).toHaveBeenCalledWith(["mcp_computer_use_click"]);
	});

	it("never calls activate for an ineligible tool", () => {
		const activate = vi.fn();
		const activator = createLazyToolActivator({
			getSearchable: () => SEARCHABLE,
			getActiveTools: () => ["read"],
			activate,
		});

		expect(activator("look_at")).toBe(false);
		expect(activate).not.toHaveBeenCalled();
	});
});
