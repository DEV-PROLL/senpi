import { afterEach, describe, expect, it } from "vitest";
import {
	connectionErrorResponse,
	createBeforeAgentStartEvent,
	createBlockingContext,
	createCompactionHandlers,
} from "../helpers/blocking-compaction-harness.ts";

/**
 * A speculative warm-start summary that fails must not turn the next blocking
 * route into a second full-budget request. Before the handoff fix, a blocking
 * waiter inherited the failed job as `undefined`, discarded it, and immediately
 * paid for a fresh request — two deadlines back to back, the exact freeze shape
 * the wall-clock budget exists to remove. The blocking route must instead
 * degrade through the watchdog-failure path on the job it already has.
 *
 * Usage math (contextWindow 10_000, adaptive ratio 0.45): trigger threshold is
 * 4_500, speculative warm-start fires at >= 3_375. 4_000 is speculative-only;
 * 4_600 triggers the blocking route.
 */
describe("Given a speculative summary that failed before a blocking route inherits it", () => {
	const registrations: Array<{ unregister(): void }> = [];
	afterEach(() => {
		for (const registration of registrations.splice(0)) {
			registration.unregister();
		}
	});

	it("Then the blocking route degrades on that job instead of paying for a second request", async () => {
		// Given: usage in the speculative-only range warms a summary that fails.
		const { beforeAgentStart } = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 4_000 });
		registrations.push(harness.registration);
		harness.registration.setResponses([connectionErrorResponse()]);

		await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).resolves.not.toThrow();
		const callsAfterSpeculative = harness.registration.state.callCount;

		// When: usage crosses into the blocking range while the failed job is pending.
		harness.setUsageTokens(4_600);
		await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).resolves.not.toThrow();

		// Then: the blocking route did not pay for a second summarization request.
		expect(harness.registration.state.callCount).toBe(callsAfterSpeculative);
	});
});
