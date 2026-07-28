import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	connectionErrorResponse,
	createBeforeAgentStartEvent,
	createBlockingContext,
	createCompactionHandlers,
} from "../helpers/blocking-compaction-harness.ts";

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

describe("blocking compaction network-failure degradation", () => {
	describe("Given the provider connection drops during emergency blocking compaction", () => {
		it("Then before_agent_start degrades cleanly instead of erroring the turn", async () => {
			// Given: usage at the hard limit forces blocking compaction, and the
			// summarization request fails with a transient connection error.
			const { beforeAgentStart } = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_950 });
			registrations.push(harness.registration);
			harness.registration.setResponses([connectionErrorResponse()]);

			// When / Then: the handler resolves (no extension-error stack surface)…
			await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).resolves.toBeUndefined();

			// …and the single clean surface is compaction_end's errorMessage.
			expect(harness.endCompaction).toHaveBeenCalledWith(
				expect.objectContaining({ errorMessage: "Compaction failed: Connection error." }),
			);
		});
	});

	describe("Given repeated transient blocking-compaction failures", () => {
		it("Then the circuit breaker skips further proactive attempts during cooldown", async () => {
			// Given: usage above the proactive threshold (45% of 10k) but below the
			// hard limit, so the proactive blocking route is taken each prompt.
			const { beforeAgentStart } = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 6_000 });
			registrations.push(harness.registration);
			harness.registration.setResponses([
				connectionErrorResponse(),
				connectionErrorResponse(),
				connectionErrorResponse(),
			]);

			// When: three consecutive prompts fail on connection errors.
			for (let attempt = 0; attempt < 3; attempt++) {
				await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).resolves.toBeUndefined();
			}
			const callsAfterTrip = harness.registration.state.callCount;
			await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).resolves.toBeUndefined();

			// Then: the tripped breaker stops the fourth prompt from paying for
			// another doomed summarization request.
			expect(callsAfterTrip).toBe(3);
			expect(harness.registration.state.callCount).toBe(callsAfterTrip);
		});
	});

	describe("Given a non-transient summarization failure", () => {
		it("Then the failure still surfaces loudly as an extension error", async () => {
			// Given: a deterministic provider rejection that retrying cannot fix.
			const { beforeAgentStart } = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_950 });
			registrations.push(harness.registration);
			harness.registration.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "request blocked by provider policy",
				}),
			]);

			// When / Then: unchanged behavior — real bugs and policy rejections
			// keep propagating so they stay visible.
			await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).rejects.toThrow(
				"request blocked by provider policy",
			);
		});
	});

	describe("Given summarization credentials are unavailable", () => {
		it("Then blocking compaction degrades silently as before", async () => {
			// Given
			const { beforeAgentStart } = createCompactionHandlers();
			const harness = createBlockingContext({ usageTokens: 9_950, withAuth: false });
			registrations.push(harness.registration);
			harness.registration.setResponses([fauxAssistantMessage("never reached")]);

			// When / Then: SummaryGenerationError keeps its degrade-to-unavailable
			// contract, with no error message on the compaction feedback.
			await expect(beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx)).resolves.toBeUndefined();
			const callsWithError = harness.endCompaction.mock.calls.filter(
				(call) => typeof call[0]?.errorMessage === "string",
			);
			expect(callsWithError).toHaveLength(0);
		});
	});
});
