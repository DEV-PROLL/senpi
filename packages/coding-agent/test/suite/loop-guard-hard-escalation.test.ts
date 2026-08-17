import { describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import loopGuardExtension from "../../src/core/extensions/builtin/loop-guard/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface LoopGuardHarness {
	fire: (eventName: string, event: unknown) => Promise<unknown>;
	actions: string[];
	customMessages: Array<{
		customType: string;
		display: boolean;
		triggerTurn: boolean | undefined;
		deliverAs: string | undefined;
	}>;
	userMessages: Array<{ content: unknown; deliverAs: string | undefined }>;
	renderers: Map<string, unknown>;
}

function createLoopGuardHarness(): LoopGuardHarness {
	const handlers = new Map<string, Handler[]>();
	const actions: string[] = [];
	const customMessages: LoopGuardHarness["customMessages"] = [];
	const userMessages: Array<{ content: unknown; deliverAs: string | undefined }> = [];
	const renderers = new Map<string, unknown>();
	const pi: ExtensionAPI = Object.assign(Object.create(null), {
		on: (event: string, handler: Handler) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		sendMessage: (
			message: { customType: string; display: boolean },
			options: { triggerTurn?: boolean; deliverAs?: string } | undefined,
		) => {
			customMessages.push({
				customType: message.customType,
				display: message.display,
				triggerTurn: options?.triggerTurn,
				deliverAs: options?.deliverAs,
			});
			if (message.customType === "loop-guard:recovery") actions.push("recovery-turn");
		},
		sendUserMessage: (content: unknown, options: { deliverAs?: string } | undefined) => {
			actions.push("user-steer");
			userMessages.push({ content, deliverAs: options?.deliverAs });
		},
		registerMessageRenderer: (customType: string, renderer: unknown) => {
			renderers.set(customType, renderer);
		},
		events: {
			emit: (channel: string, data: unknown) => {
				if (channel === "wake_source_state" && isRecord(data) && typeof data.activeCount === "number") {
					actions.push(`wake-source:${data.activeCount}`);
				}
			},
		},
	});
	loopGuardExtension(pi);
	const ui: ExtensionContext["ui"] = Object.assign(Object.create(null), {
		notify: () => {
			actions.push("warning");
		},
	});
	const ctx: ExtensionContext = Object.assign(Object.create(null), {
		hasUI: true,
		ui,
		abort: (source: "user" | "system" | undefined) => {
			actions.push(`abort:${source ?? "user"}`);
		},
	});
	const fire = async (eventName: string, event: unknown): Promise<unknown> => {
		let result: unknown;
		for (const handler of handlers.get(eventName) ?? []) {
			const candidate = await handler(event, ctx);
			if (candidate !== undefined) result = candidate;
		}
		return result;
	};
	return { fire, actions, customMessages, userMessages, renderers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function attempt(
	harness: LoopGuardHarness,
	toolCallId: string,
	toolName: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	await harness.fire("tool_execution_start", {
		type: "tool_execution_start",
		toolCallId,
		toolName,
		args: input,
	});
	const result = await harness.fire("tool_call", {
		type: "tool_call",
		toolCallId,
		toolName,
		input,
	});
	await harness.fire("turn_end", {
		type: "turn_end",
		message: { role: "assistant", content: [] },
		toolResults: [],
	});
	return result;
}

describe("loop-guard hard escalation", () => {
	it("runs before hooks and permission policy so its block wins first", () => {
		expect(builtinExtensions.slice(0, 3).map(({ id }) => id)).toEqual(["loop-guard", "hooks", "permission-system"]);
	});

	it("blocks the next identical call only after the second notice turn ends", async () => {
		const harness = createLoopGuardHarness();
		for (let index = 1; index <= 6; index++) {
			expect(await attempt(harness, `call-${index}`, "todo", { op: "view" })).toBeUndefined();
		}

		const blocked = await attempt(harness, "call-7", "todo", { op: "view" });

		expect(blocked).toMatchObject({ block: true, terminate: false });
		expect(isRecord(blocked)).toBe(true);
		if (!isRecord(blocked)) return;
		expect(typeof blocked.reason).toBe("string");
		expect(blocked.reason).not.toMatch(/\babort(?:ed)?\b/i);
	});

	it("clears the active block when the tool arguments change", async () => {
		const harness = createLoopGuardHarness();
		for (let index = 1; index <= 6; index++) {
			await attempt(harness, `call-${index}`, "read", { path: "a.ts" });
		}
		expect(await attempt(harness, "call-7", "read", { path: "a.ts" })).toMatchObject({ block: true });

		expect(await attempt(harness, "call-8", "read", { path: "b.ts" })).toBeUndefined();
	});

	it("does not block a tool_call without a correlated execution-start event", async () => {
		const harness = createLoopGuardHarness();
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolCallId: "bridge-call",
				toolName: "todo",
				input: { op: "view" },
			}),
		).toBeUndefined();
	});

	it("hard-stops on the third blocked call and queues the user wake after settlement", async () => {
		const harness = createLoopGuardHarness();
		for (let index = 1; index <= 6; index++) {
			await attempt(harness, `call-${index}`, "todo", { op: "view" });
		}
		await attempt(harness, "call-7", "todo", { op: "view" });
		await attempt(harness, "call-8", "todo", { op: "view" });

		const hardStop = await attempt(harness, "call-9", "todo", { op: "view" });

		expect(hardStop).toMatchObject({ block: true, terminate: false });
		expect(harness.actions).toEqual(["wake-source:1", "warning", "abort:system"]);
		expect(harness.userMessages).toHaveLength(0);
		await harness.fire("agent_settled", { type: "agent_settled" });
		expect(harness.actions).toEqual(["wake-source:1", "warning", "abort:system", "recovery-turn"]);
		await harness.fire("agent_start", { type: "agent_start" });
		expect(harness.actions).toEqual(["wake-source:1", "warning", "abort:system", "recovery-turn", "wake-source:0"]);
		expect(harness.userMessages).toHaveLength(0);
		expect(harness.customMessages.filter(({ customType }) => customType === "loop-guard:escalation")).toMatchObject([
			{
				customType: "loop-guard:escalation",
				display: true,
				triggerTurn: false,
				deliverAs: "steer",
			},
		]);
		expect(harness.customMessages.filter(({ customType }) => customType === "loop-guard:recovery")).toEqual([
			{
				customType: "loop-guard:recovery",
				display: false,
				triggerTurn: true,
				deliverAs: undefined,
			},
		]);
		expect(harness.renderers.has("loop-guard:escalation")).toBe(true);
	});

	it("repeats only the system abort after the hard-stop warning is announced", async () => {
		const harness = createLoopGuardHarness();
		for (let index = 1; index <= 9; index++) {
			await attempt(harness, `call-${index}`, "todo", { op: "view" });
		}
		await harness.fire("agent_settled", { type: "agent_settled" });
		await harness.fire("agent_start", { type: "agent_start" });
		harness.actions.length = 0;

		expect(await attempt(harness, "call-10", "todo", { op: "view" })).toMatchObject({
			block: true,
			terminate: false,
		});
		expect(harness.actions).toEqual(["abort:system"]);
		expect(harness.userMessages).toHaveLength(0);
		expect(harness.customMessages.filter(({ customType }) => customType === "loop-guard:escalation")).toHaveLength(1);
		expect(harness.customMessages.filter(({ customType }) => customType === "loop-guard:recovery")).toHaveLength(1);
	});

	it("does not apply a loop block to an uncorrelated sibling tool call", async () => {
		const harness = createLoopGuardHarness();
		for (let index = 1; index <= 6; index++) {
			await attempt(harness, `call-${index}`, "todo", { op: "view" });
		}
		await harness.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "loop-call",
			toolName: "todo",
			args: { op: "view" },
		});

		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolCallId: "sibling-call",
				toolName: "read",
				input: { path: "a.ts" },
			}),
		).toBeUndefined();
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolCallId: "loop-call",
				toolName: "todo",
				input: { op: "view" },
			}),
		).toMatchObject({ block: true });
	});
});
