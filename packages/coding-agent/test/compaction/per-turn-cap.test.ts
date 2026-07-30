import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import {
	hardCap,
	incrementAccepted,
	shouldRejectByCap,
	softCap,
} from "../../src/core/extensions/builtin/compaction/per-turn-cap.ts";
import { resetTurnCounter } from "../../src/core/extensions/builtin/compaction/state.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionCompactEvent,
} from "../../src/core/extensions/index.ts";
import type { CompactionReason } from "../../src/core/extensions/types.ts";
import { migrateSessionEntries, parseSessionEntries, type SessionEntry } from "../../src/core/session-manager.ts";
import { type BlockingHarness, createBlockingContext } from "../helpers/blocking-compaction-harness.ts";

interface FutureCapState {
	acceptedThisTurn: number;
	acceptedAbsolute: number;
}

type IncrementAcceptedFn = (state: FutureCapState) => FutureCapState;
type ShouldRejectByCapFn = (state: FutureCapState, opts?: { manual?: boolean }) => { cancel: boolean };
type ResetTurnCounterFn = (state: FutureCapState) => FutureCapState;

const incrementAcceptedFuture = incrementAccepted as unknown as IncrementAcceptedFn;
const shouldRejectByCapFuture = shouldRejectByCap as unknown as ShouldRejectByCapFn;
const resetTurnCounterFuture = resetTurnCounter as unknown as ResetTurnCounterFn;

const EXPECTED_SOFT_CAP = 3;
const EXPECTED_HARD_CAP = 10;

function createInitialCapState(): FutureCapState {
	return { acceptedThisTurn: 0, acceptedAbsolute: 0 };
}

function acceptN(state: FutureCapState, n: number): FutureCapState {
	let next = state;
	for (let i = 0; i < n; i++) {
		next = incrementAcceptedFuture(next);
	}
	return next;
}

interface CapHandlers {
	beforeCompact: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>;
	sessionCompact: ExtensionHandler<SessionCompactEvent, void>;
}

function createCapHandlers(): CapHandlers {
	let beforeCompact: CapHandlers["beforeCompact"] | undefined;
	let sessionCompact: CapHandlers["sessionCompact"] | undefined;
	compactionExtension({
		events: { emit: () => undefined },
		on: (event: string, handler: unknown) => {
			if (event === "session_before_compact") {
				beforeCompact = handler as CapHandlers["beforeCompact"];
			}
			if (event === "session_compact") {
				sessionCompact = handler as CapHandlers["sessionCompact"];
			}
		},
	} as unknown as ExtensionAPI);
	if (!beforeCompact || !sessionCompact) {
		throw new Error("Compaction extension did not register cap handlers");
	}
	return { beforeCompact, sessionCompact };
}

async function reachAbsoluteHardCap(handlers: CapHandlers, harness: BlockingHarness): Promise<void> {
	for (let accepted = 1; accepted <= EXPECTED_HARD_CAP; accepted++) {
		await handlers.sessionCompact(
			{
				type: "session_compact",
				reason: "threshold",
				requestId: `accepted-${accepted}`,
				accepted: true,
				compactionEntry: {
					type: "compaction",
					id: `compaction-${accepted}`,
					parentId: harness.ctx.sessionManager.getLeafId(),
					timestamp: new Date(accepted).toISOString(),
					summary: `accepted summary ${accepted}`,
					firstKeptEntryId: "kept",
					tokensBefore: 10_000,
				},
				fromExtension: true,
				willRetry: false,
			},
			harness.ctx as ExtensionContext,
		);
	}
}

function capBoundaryEvent(reason: CompactionReason): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason,
		willRetry: false,
		requestId: `${reason}-at-hard-cap`,
		preparation: {
			firstKeptEntryId: "kept",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 10_000,
			fileOps: { read: new Set(), edited: new Set(), written: new Set() },
			settings: harnessSettings,
		},
		branchEntries: [],
		signal: new AbortController().signal,
	};
}

const harnessSettings = {
	enabled: true,
	reserveTokens: 100,
	keepRecentTokens: 2_000,
};

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

let perTurnFixtureEntries: SessionEntry[] = [];

beforeAll(() => {
	const fixturePath = join(
		__dirname,
		"..",
		"fixtures",
		"compaction",
		"per-turn-cap",
		"four-back-to-back-compactions.jsonl",
	);
	const content = readFileSync(fixturePath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries);
	perTurnFixtureEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
});

describe("compaction per-turn cap", () => {
	describe("Given a fresh turn with the soft cap of 3 accepted compactions", () => {
		describe("When 3 compactions are accepted and a 4th is checked", () => {
			it("Then the 4th compaction is rejected with { cancel: true }", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				expect(softCap).toBe(EXPECTED_SOFT_CAP);
				const compactionEntries = perTurnFixtureEntries.filter((entry) => entry.type === "compaction");
				expect(compactionEntries.length).toBeGreaterThanOrEqual(EXPECTED_SOFT_CAP + 1);

				const stateAfterThree = acceptN(createInitialCapState(), EXPECTED_SOFT_CAP);
				const decision = shouldRejectByCapFuture(stateAfterThree);

				expect(stateAfterThree.acceptedThisTurn).toBe(EXPECTED_SOFT_CAP);
				expect(decision).toEqual({ cancel: true });
			});
		});
	});

	describe("Given the soft cap has been reached this turn", () => {
		describe("When the turn ends and resetTurnCounter is applied", () => {
			it("Then the per-turn counter resets to 0 and the next compaction is accepted", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				const stateAtCap = acceptN(createInitialCapState(), EXPECTED_SOFT_CAP);
				expect(shouldRejectByCapFuture(stateAtCap)).toEqual({ cancel: true });

				const stateAfterTurnEnd = resetTurnCounterFuture(stateAtCap);

				expect(stateAfterTurnEnd.acceptedThisTurn).toBe(0);
				expect(shouldRejectByCapFuture(stateAfterTurnEnd)).toEqual({ cancel: false });
			});
		});
	});

	describe("Given the soft cap has been reached and the absolute hard cap is 10", () => {
		describe("When a manual /compact is checked with manual: true", () => {
			it("Then the cap is bypassed and the manual compaction is accepted", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				expect(hardCap).toBe(EXPECTED_HARD_CAP);

				const stateAtSoftCap: FutureCapState = {
					acceptedThisTurn: EXPECTED_SOFT_CAP,
					acceptedAbsolute: EXPECTED_SOFT_CAP,
				};
				expect(shouldRejectByCapFuture(stateAtSoftCap)).toEqual({ cancel: true });

				const manualDecision = shouldRejectByCapFuture(stateAtSoftCap, { manual: true });

				expect(manualDecision).toEqual({ cancel: false });
				expect(stateAtSoftCap.acceptedAbsolute).toBeLessThan(EXPECTED_HARD_CAP);
			});
		});
	});

	describe("Given acceptedAbsolute is exactly the absolute hard cap", () => {
		it.each(["manual", "extension"] as const)(
			"rejects a %s-triggered attempt before the compaction generator runs",
			async (reason) => {
				const handlers = createCapHandlers();
				const harness = createBlockingContext({ usageTokens: 9_950 });
				registrations.push(harness.registration);
				harness.registration.setResponses([]);
				expect(hardCap).toBe(EXPECTED_HARD_CAP);
				await reachAbsoluteHardCap(handlers, harness);

				const result = await handlers.beforeCompact(capBoundaryEvent(reason), harness.ctx as ExtensionContext);

				expect(result).toEqual({
					cancel: true,
					rejectionCause: "per-turn-cap",
					reason: "per-turn compaction cap reached for this turn",
				});
				expect(harness.registration.getCallLog()).toHaveLength(0);
			},
		);
	});

	describe("Given the soft cap was reached and the session is reloaded with fresh in-memory state", () => {
		describe("When the per-turn counter is read on the reloaded state", () => {
			it("Then the counter is 0 and the next compaction is accepted", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				const preReloadState = acceptN(createInitialCapState(), EXPECTED_SOFT_CAP);
				expect(preReloadState.acceptedThisTurn).toBe(EXPECTED_SOFT_CAP);

				const reloadedState = createInitialCapState();

				expect(reloadedState.acceptedThisTurn).toBe(0);
				expect(reloadedState.acceptedAbsolute).toBe(0);
				expect(shouldRejectByCapFuture(reloadedState)).toEqual({ cancel: false });
			});
		});
	});
});
