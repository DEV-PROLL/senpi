import { describe, expect, it } from "vitest";
import {
	corroboratesControlLeak,
	createControlLeakDetector,
	type PendingControlEvidence,
} from "../../src/core/extensions/builtin/ttsr/detectors/control-leak.ts";
import {
	bracket,
	CONTROL_LEAK_CTX,
	ctrl,
	expectNoLeakMatchEverywhere,
	PLAIN_PROSE_PREFIX,
	requireEvidence,
	runSplitMatrix,
	sgml,
} from "./control-leak-helpers.ts";

const FENCE = "`".repeat(3);
const EVIDENCE_TTL_CHARS = 2048;
const MAX_GAP_WHITESPACE = 32;

function wrappedFlood(lines: number): string {
	return Array.from({ length: lines }, () => "!".repeat(80)).join("\n");
}

describe("pending control evidence", () => {
	it("M-1 token then wrapped flood keeps adjacent evidence that corroborates", () => {
		const token = ctrl("close");
		const flood = wrappedFlood(12);
		const fixture = `${token}\n${flood}`;
		const floodStart = token.length + 1;
		const results = runSplitMatrix(fixture, [token]);
		expectNoLeakMatchEverywhere(results);
		for (const result of results) {
			const evidence = requireEvidence(result);
			expect(evidence.tokenId, result.label).toBe("ctrl:close");
			expect(evidence.family, result.label).toBe("ctrl");
			expect(evidence.startOffset, result.label).toBe(0);
			expect(evidence.endOffset, result.label).toBe(token.length);
			expect(evidence.quotationLike, result.label).toBe(false);
			expect(evidence.gapLength, result.label).toBe(1);
			expect(evidence.firstPayloadOffset, result.label).toBe(floodStart);
			expect(evidence.expiresAtOffset, result.label).toBe(token.length + EVIDENCE_TTL_CHARS);
			expect(corroboratesControlLeak(evidence, floodStart, result.state.currentOffset), result.label).toBe(true);
			expect(corroboratesControlLeak(evidence, floodStart + 5, result.state.currentOffset), result.label).toBe(
				false,
			);
		}
	});

	it("M-2 token and flood in one delta corroborate with zero gap", () => {
		const token = ctrl("close");
		const flood = "!".repeat(300);
		const fixture = token + flood;
		const results = runSplitMatrix(fixture, [token]);
		expectNoLeakMatchEverywhere(results);
		for (const result of results) {
			const evidence = requireEvidence(result);
			expect(evidence.gapLength, result.label).toBe(0);
			expect(evidence.firstPayloadOffset, result.label).toBe(token.length);
			expect(corroboratesControlLeak(evidence, token.length, result.state.currentOffset), result.label).toBe(true);
		}
	});

	it("M-3 token split across deltas still corroborates the adjacent flood", () => {
		const token = ctrl("close");
		const fixture = `${token}\n${wrappedFlood(6)}`;
		const results = runSplitMatrix(fixture, [token]);
		for (const result of results) {
			const evidence = requireEvidence(result);
			expect(corroboratesControlLeak(evidence, token.length + 1, result.state.currentOffset), result.label).toBe(
				true,
			);
		}
	});

	it("M-4 ordinary prose between token and flood breaks adjacency", () => {
		const token = ctrl("close");
		const prose = " but then the answer continued for a while. ";
		const fixture = `${token}${prose}${"!".repeat(300)}`;
		const floodStart = token.length + prose.length;
		const results = runSplitMatrix(fixture, [token]);
		expectNoLeakMatchEverywhere(results);
		for (const result of results) {
			const evidence = requireEvidence(result);
			expect(evidence.firstPayloadOffset, result.label).toBe(token.length + 1);
			expect(corroboratesControlLeak(evidence, floodStart, result.state.currentOffset), result.label).toBe(false);
		}
	});

	it("M-5 whitespace gap beyond 32 chars breaks corroboration", () => {
		const token = ctrl("close");
		const fixture = `${token}${" ".repeat(40)}${"!".repeat(300)}`;
		const floodStart = token.length + 40;
		const results = runSplitMatrix(fixture, [token]);
		expectNoLeakMatchEverywhere(results);
		for (const result of results) {
			const evidence = requireEvidence(result);
			expect(evidence.gapLength, result.label).toBeGreaterThan(MAX_GAP_WHITESPACE);
			expect(corroboratesControlLeak(evidence, floodStart, result.state.currentOffset), result.label).toBe(false);
		}
	});

	it("M-6 quotation-like evidence still corroborates", () => {
		const token = ctrl("close");
		const fixture = `${FENCE}\n${token}\n${"!".repeat(300)}\n${FENCE}`;
		const floodStart = FENCE.length + 1 + token.length + 1;
		const results = runSplitMatrix(fixture, [token]);
		expectNoLeakMatchEverywhere(results);
		for (const result of results) {
			const evidence = requireEvidence(result);
			expect(evidence.quotationLike, result.label).toBe(true);
			expect(corroboratesControlLeak(evidence, floodStart, result.state.currentOffset), result.label).toBe(true);
		}
	});

	it("M-7 a firing run latches and late deltas return the same match", () => {
		const token = ctrl("close");
		const flood = "!".repeat(300);
		const fixture = `${[token, token, token].join(" ")}\n${flood}`;
		const detector = createControlLeakDetector();
		const state = detector.createState();
		const first = detector.checkDelta(state, fixture, CONTROL_LEAK_CTX);
		expect(first).not.toBeNull();
		expect(first?.rule).toBe("control-token-leak");
		const late = detector.checkDelta(state, `${token} ${flood}`, CONTROL_LEAK_CTX);
		expect(late).toBe(first);
		expect(detector.flush === undefined ? null : detector.flush(state, CONTROL_LEAK_CTX)).toBe(first);
	});

	it("evidence with no payload yet cannot corroborate", () => {
		const token = ctrl("close");
		const fixture = `${PLAIN_PROSE_PREFIX} ${token}`;
		const results = runSplitMatrix(fixture, [token]);
		expectNoLeakMatchEverywhere(results);
		for (const result of results) {
			const evidence = requireEvidence(result);
			expect(evidence.firstPayloadOffset, result.label).toBe(-1);
			expect(corroboratesControlLeak(evidence, result.state.currentOffset, result.state.currentOffset)).toBe(false);
		}
	});

	it("gap of exactly 32 whitespace chars corroborates and 33 does not", () => {
		const token = ctrl("close");
		const within = `${token}${" ".repeat(MAX_GAP_WHITESPACE)}${"!".repeat(40)}`;
		const withinStart = token.length + MAX_GAP_WHITESPACE;
		for (const result of runSplitMatrix(within, [token])) {
			const evidence = requireEvidence(result);
			expect(evidence.gapLength, result.label).toBe(MAX_GAP_WHITESPACE);
			expect(corroboratesControlLeak(evidence, withinStart, result.state.currentOffset), result.label).toBe(true);
		}
		const beyond = `${token}${" ".repeat(MAX_GAP_WHITESPACE + 1)}${"!".repeat(40)}`;
		const beyondStart = token.length + MAX_GAP_WHITESPACE + 1;
		for (const result of runSplitMatrix(beyond, [token])) {
			const evidence = requireEvidence(result);
			expect(corroboratesControlLeak(evidence, beyondStart, result.state.currentOffset), result.label).toBe(false);
		}
	});

	it("evidence expires after 2048 streamed chars", () => {
		const token = ctrl("close");
		const detector = createControlLeakDetector();
		const state = detector.createState();
		expect(detector.checkDelta(state, `${token}!`, CONTROL_LEAK_CTX)).toBeNull();
		const evidence = state.pendingEvidence;
		if (evidence === undefined) {
			throw new Error("pending evidence missing");
		}
		const payloadOffset = token.length;
		expect(evidence.firstPayloadOffset).toBe(payloadOffset);
		const fillToExpiry = EVIDENCE_TTL_CHARS - 1;
		detector.checkDelta(state, "x".repeat(fillToExpiry), CONTROL_LEAK_CTX);
		expect(state.currentOffset).toBe(evidence.expiresAtOffset);
		expect(corroboratesControlLeak(evidence, payloadOffset, state.currentOffset)).toBe(true);
		detector.checkDelta(state, "x", CONTROL_LEAK_CTX);
		expect(state.currentOffset).toBe(evidence.expiresAtOffset + 1);
		expect(corroboratesControlLeak(evidence, payloadOffset, state.currentOffset)).toBe(false);
	});

	it("bracket and sgml families produce evidence with matching family tags", () => {
		const open = sgml("s");
		const pad = bracket("PAD");
		const fixture = `${PLAIN_PROSE_PREFIX} ${open} ${pad} tail`;
		const results = runSplitMatrix(fixture, [open, pad]);
		expectNoLeakMatchEverywhere(results);
		for (const result of results) {
			const evidence: PendingControlEvidence = requireEvidence(result);
			expect(evidence.family, result.label).toBe("bracket");
			expect(evidence.tokenId, result.label).toBe("bracket:PAD");
			expect(evidence.firstPayloadOffset, result.label).toBe(fixture.indexOf("tail"));
		}
	});
});
