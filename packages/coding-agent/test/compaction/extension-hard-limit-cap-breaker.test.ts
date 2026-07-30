import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionCompactEvent,
} from "../../src/core/extensions/index.ts";
import { type BlockingHarness, createBlockingContext } from "../helpers/blocking-compaction-harness.ts";

interface CompactionHandlers {
	beforeAgentStart: NonNullable<ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>>;
	sessionCompact: NonNullable<ExtensionHandler<SessionCompactEvent, void>>;
}

function createHandlers(): CompactionHandlers {
	let beforeAgentStart: CompactionHandlers["beforeAgentStart"] | undefined;
	let sessionCompact: CompactionHandlers["sessionCompact"] | undefined;
	compactionExtension({
		events: { emit: () => undefined },
		on: (event: string, handler: unknown) => {
			if (event === "before_agent_start") {
				beforeAgentStart = handler as CompactionHandlers["beforeAgentStart"];
			}
			if (event === "session_compact") {
				sessionCompact = handler as CompactionHandlers["sessionCompact"];
			}
		},
	} as unknown as ExtensionAPI);
	expect(beforeAgentStart).toBeDefined();
	expect(sessionCompact).toBeDefined();
	return {
		beforeAgentStart: beforeAgentStart as CompactionHandlers["beforeAgentStart"],
		sessionCompact: sessionCompact as CompactionHandlers["sessionCompact"],
	};
}

function hardLimitEvent(): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "continue",
		systemPrompt: "system",
		systemPromptOptions: Object.create(null) as BeforeAgentStartEvent["systemPromptOptions"],
	};
}

async function emitRejectedCompaction(
	handlers: CompactionHandlers,
	harness: BlockingHarness,
	generation: number,
): Promise<void> {
	await handlers.sessionCompact(
		{
			type: "session_compact",
			reason: "threshold",
			accepted: false,
			fromExtension: false,
			willRetry: false,
			requestId: `breaker-${generation}`,
			rejectionCause: "cancelled-by-extension",
		},
		harness.ctx as ExtensionContext,
	);
}

async function emitIneffectiveCompaction(
	handlers: CompactionHandlers,
	harness: BlockingHarness,
	generation: number,
): Promise<void> {
	await handlers.sessionCompact(
		{
			type: "session_compact",
			reason: "threshold",
			accepted: true,
			fromExtension: true,
			willRetry: false,
			requestId: `ineffective-${generation}`,
			compactionEntry: {
				type: "compaction",
				id: `ineffective-entry-${generation}`,
				parentId: harness.ctx.sessionManager.getLeafId(),
				timestamp: new Date().toISOString(),
				summary: "summary",
				firstKeptEntryId: "kept",
				tokensBefore: 10_000,
				details: {
					structuralYield: { savedTokens: 0, savingsRatio: 0, meetsMinimum: false },
				},
				fromHook: true,
			},
		},
		harness.ctx as ExtensionContext,
	);
}

describe("extension hard-limit cap and breaker guards", () => {
	it("does not invoke a blocking summary while the circuit breaker is open", async () => {
		const handlers = createHandlers();
		const harness = createBlockingContext({ usageTokens: 9_950 });
		harness.registration.setResponses([fauxAssistantMessage("must not be used")]);
		await emitRejectedCompaction(handlers, harness, 1);
		await emitRejectedCompaction(handlers, harness, 2);
		await emitRejectedCompaction(handlers, harness, 3);

		const result = await handlers.beforeAgentStart(hardLimitEvent(), harness.ctx as ExtensionContext);

		expect(harness.registration.getCallLog()).toHaveLength(0);
		expect(result).toBeUndefined();
	});

	it("counts accepted ineffective compactions against the hard-limit cap", async () => {
		const handlers = createHandlers();
		const harness = createBlockingContext({ usageTokens: 9_950 });
		harness.registration.setResponses([fauxAssistantMessage("must not be used")]);
		await emitIneffectiveCompaction(handlers, harness, 1);
		await emitIneffectiveCompaction(handlers, harness, 2);

		const result = await handlers.beforeAgentStart(hardLimitEvent(), harness.ctx as ExtensionContext);

		expect(harness.registration.getCallLog()).toHaveLength(0);
		expect(result).toBeUndefined();
	});
});
