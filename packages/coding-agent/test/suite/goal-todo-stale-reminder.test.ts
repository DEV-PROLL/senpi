import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { staleGoalTodoReminder, todoResultAddsOpenTasks } from "../../src/core/extensions/builtin/goal/todo-gate.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import type { TodoPhase, TodoToolDetails } from "../../src/core/extensions/builtin/todotools/state.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

function goalFixture(status: Goal["status"]): Goal {
	return {
		id: "goal-1",
		threadId: "thread-1",
		objective: "Ship the feature",
		status,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 1,
		updatedAt: 1,
		...(status === "blocked" ? { blockedReason: "stuck", blockedAt: 1 } : {}),
		...(status === "complete" ? { completedAt: 1 } : {}),
	};
}

function todoDetails(op: TodoToolDetails["op"], phases: TodoPhase[]): TodoToolDetails {
	return { op, phases, storage: "memory" };
}

const OPEN_PHASES: TodoPhase[] = [
	{
		name: "Tasks",
		tasks: [
			{ content: "Write the failing test", status: "in_progress" },
			{ content: "Make it pass", status: "pending" },
		],
	},
];

const CLOSED_PHASES: TodoPhase[] = [
	{
		name: "Tasks",
		tasks: [
			{ content: "Write the failing test", status: "completed" },
			{ content: "Make it pass", status: "abandoned" },
		],
	},
];

describe("staleGoalTodoReminder", () => {
	it("prompts goal registration when no goal exists", () => {
		const reminder = staleGoalTodoReminder(null);
		expect(reminder).toBeDefined();
		expect(reminder).toContain("<system-reminder>");
		expect(reminder).toContain("</system-reminder>");
		expect(reminder).toContain("create_goal");
		expect(reminder).toContain("no goal");
	});

	it("prompts goal replacement when the goal is already complete", () => {
		const reminder = staleGoalTodoReminder(goalFixture("complete"));
		expect(reminder).toBeDefined();
		expect(reminder).toContain("<system-reminder>");
		expect(reminder).toContain("create_goal");
		expect(reminder).toContain("complete");
	});

	it.each(["active", "paused", "blocked"] as const)("stays silent for a %s goal", (status) => {
		expect(staleGoalTodoReminder(goalFixture(status))).toBeUndefined();
	});
});

describe("todoResultAddsOpenTasks", () => {
	it("accepts init results that leave open tasks", () => {
		expect(todoResultAddsOpenTasks(todoDetails("init", OPEN_PHASES))).toBe(true);
	});

	it("accepts append results that leave open tasks", () => {
		expect(todoResultAddsOpenTasks(todoDetails("append", OPEN_PHASES))).toBe(true);
	});

	it.each(["start", "done", "drop", "rm", "view"] as const)("rejects the non-add %s operation", (op) => {
		expect(todoResultAddsOpenTasks(todoDetails(op, OPEN_PHASES))).toBe(false);
	});

	it("rejects add results that leave no open task", () => {
		expect(todoResultAddsOpenTasks(todoDetails("init", CLOSED_PHASES))).toBe(false);
	});

	it("rejects malformed details", () => {
		expect(todoResultAddsOpenTasks(undefined)).toBe(false);
		expect(todoResultAddsOpenTasks(null)).toBe(false);
		expect(todoResultAddsOpenTasks({})).toBe(false);
		expect(todoResultAddsOpenTasks({ op: "init" })).toBe(false);
		expect(todoResultAddsOpenTasks({ op: "init", phases: "nope" })).toBe(false);
	});
});

async function createGoalTodoHarness(): Promise<Harness> {
	const harness = await createHarness({ extensionFactories: [goalExtension, todotoolsExtension] });
	harnesses.push(harness);
	return harness;
}

function todoResultTexts(harness: Harness): string[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message)
		.filter((message): message is typeof message & { role: "toolResult"; toolName: string } => {
			const candidate = message as { role?: string; toolName?: string };
			return candidate.role === "toolResult" && candidate.toolName === "todo";
		})
		.map((message) => getMessageText(message));
}

function reminderCount(texts: readonly string[]): number {
	return texts.filter((text) => text.includes("<system-reminder>")).length;
}

describe("stale-goal todo reminder end-to-end through the real AgentSession", () => {
	it("injects a create_goal reminder into the todo result when no goal is registered", async () => {
		const harness = await createGoalTodoHarness();

		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("todo", { op: "init", list: [{ phase: "Build", items: ["Task A", "Task B"] }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("todos registered"),
		]);
		await harness.session.prompt("track this work");

		const texts = todoResultTexts(harness);
		expect(texts).toHaveLength(1);
		expect(texts[0]).toContain("<system-reminder>");
		expect(texts[0]).toContain("create_goal");
		expect(texts[0]).toContain("no goal");
	}, 20_000);

	it("injects a stale-goal reminder when the registered goal is already complete", async () => {
		const harness = await createGoalTodoHarness();

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Ship the feature" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("todo", { op: "init", items: ["Follow-up task"] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("todos registered"),
		]);
		await harness.session.prompt("finish the goal then queue new work");

		const texts = todoResultTexts(harness);
		expect(texts).toHaveLength(1);
		expect(texts[0]).toContain("<system-reminder>");
		expect(texts[0]).toContain("create_goal");
		expect(texts[0]).toContain("complete");
	}, 20_000);

	it("stays silent when the goal is active and for non-add operations", async () => {
		const harness = await createGoalTodoHarness();

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Ship the feature" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("todo", { op: "init", items: ["Task A"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("todo", { op: "done", task: "Task A" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("all done"),
		]);
		await harness.session.prompt("set the goal, work, and finish");

		const texts = todoResultTexts(harness);
		expect(texts).toHaveLength(2);
		expect(reminderCount(texts)).toBe(0);
	}, 20_000);

	it("injects at most one reminder per turn when init and append run in the same turn", async () => {
		const harness = await createGoalTodoHarness();

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("todo", { op: "init", list: [{ phase: "Build", items: ["Task A"] }] }),
					fauxToolCall("todo", { op: "append", phase: "Build", items: ["Task B"] }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("todos registered"),
		]);
		await harness.session.prompt("track this work");

		const texts = todoResultTexts(harness);
		expect(texts).toHaveLength(2);
		expect(reminderCount(texts)).toBe(1);
		expect(texts[0]).toContain("<system-reminder>");
		expect(texts[1]).not.toContain("<system-reminder>");
	}, 20_000);
});
