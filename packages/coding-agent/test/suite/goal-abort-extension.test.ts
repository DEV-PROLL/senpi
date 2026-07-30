import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal, updateGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import type { GoalStatus } from "../../src/core/extensions/builtin/goal/types.ts";
import { createHarness, type Harness } from "./harness.ts";

type AgentEndSnapshot = {
	aborted: boolean | undefined;
	abortSource: "user" | "system" | undefined;
	status: GoalStatus | undefined;
	tokensUsed: number | undefined;
	pendingMessages: boolean;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

describe("goal abort lifecycle through the agent session", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("marks an ESC-aborted goal blocked only after usage accounting, suppresses continuation, and stays blocked on the next user run", async () => {
		const streamStarted = deferred();
		const agentEnds: AgentEndSnapshot[] = [];
		const statusesAtAgentStart: GoalStatus[] = [];
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				goalExtension,
				(pi) => {
					pi.on("message_update", (event) => {
						if (event.message.role === "assistant") streamStarted.resolve();
					});
					pi.on("agent_start", async (_event, ctx) => {
						const goal = await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd));
						if (goal) statusesAtAgentStart.push(goal.status);
					});
					pi.on("agent_end", async (event, ctx) => {
						const goal = await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd));
						agentEnds.push({
							aborted: event.aborted,
							abortSource: event.abortSource,
							status: goal?.status,
							tokensUsed: goal?.tokensUsed,
							pendingMessages: ctx.hasPendingMessages(),
						});
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		await createGoal(ref, "Finish the interrupted task");
		harness.setResponses([fauxAssistantMessage("streaming response ".repeat(4_000))]);

		// Drive the goal turn as an extension-sourced continuation so the goal stays active
		// through the run (a direct interactive prompt would pause it before the abort).
		const interruptedRun = harness.session.prompt("start the active goal", { source: "extension" });
		await streamStarted.promise;
		await harness.session.abort();
		await interruptedRun;

		expect(agentEnds).toEqual([
			expect.objectContaining({
				aborted: true,
				abortSource: "user",
				status: "blocked",
				tokensUsed: expect.any(Number),
				pendingMessages: false,
			}),
		]);
		expect(agentEnds[0]?.tokensUsed).toBeGreaterThan(0);
		expect(await readGoal(ref)).toMatchObject({
			status: "blocked",
			blockedReason: "user interrupted the turn",
		});

		// A direct user prompt must not auto-resume a blocked goal; it stays blocked until
		// an explicit /goal resume, and the model's normal turn does not touch it.
		harness.setResponses([fauxAssistantMessage("answered without touching the blocked goal")]);
		await harness.session.prompt("continue after interruption");

		expect(statusesAtAgentStart).toEqual(["active", "blocked"]);
		expect((await readGoal(ref))?.status).toBe("blocked");
	});

	it("does not mark a normally completed agent run as aborted", async () => {
		const observed: Array<{ aborted: boolean | undefined; abortSource: string | undefined }> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", (event) => {
						observed.push({ aborted: event.aborted, abortSource: event.abortSource });
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("normal completion")]);

		await harness.session.prompt("run normally");

		expect(observed).toEqual([{ aborted: undefined, abortSource: undefined }]);
		expect(observed).toEqual([{ aborted: undefined, abortSource: undefined }]);
	});
	it("keeps a blocked goal blocked at before_agent_start (no auto-unblock)", async () => {
		const statusesAtBeforeAgentStart: GoalStatus[] = [];
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				goalExtension,
				(pi) => {
					pi.on("before_agent_start", async (_event, ctx) => {
						const goal = await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd));
						if (goal) statusesAtBeforeAgentStart.push(goal.status);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		await createGoal(ref, "Wait for the user");
		await updateGoal(ref, { status: "blocked", reason: "waiting on the user" });

		harness.setResponses([fauxAssistantMessage("answered without resuming")]);
		await harness.session.prompt("user returns");

		// The auto-unblock at before_agent_start was removed: the goal stays blocked until an
		// explicit /goal resume (re-arm-once is covered deterministically in the unit tests).
		expect(statusesAtBeforeAgentStart).toEqual(["blocked"]);
		expect((await readGoal(ref))?.status).toBe("blocked");
	});
});
