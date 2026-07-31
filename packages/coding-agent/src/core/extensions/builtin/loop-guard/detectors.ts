import {
	CYCLE_MAX_PERIOD,
	CYCLE_MIN_PERIOD,
	CYCLE_REPETITION_THRESHOLD,
	ESCALATION_FACTOR,
	IDENTICAL_RUN_THRESHOLD,
	SIMILAR_RUN_THRESHOLD,
	SIMILARITY_THRESHOLD,
} from "./policy.ts";
import { meanAdjacentSimilarity } from "./similarity.ts";
import type { ToolCallRecord } from "./tracker.ts";

export type LoopGuardDetection =
	| { readonly kind: "identical"; readonly toolName: string; readonly count: number; readonly fingerprint: string }
	| {
			readonly kind: "similar";
			readonly toolName: string;
			readonly count: number;
			readonly similarity: number;
			readonly fingerprint: string;
	  }
	| {
			readonly kind: "cycle";
			readonly period: number;
			readonly count: number;
			readonly cycleTools: readonly string[];
			readonly fingerprint: string;
	  };

export type LoopGuardKind = LoopGuardDetection["kind"];

export function detectIdenticalRun(records: readonly ToolCallRecord[]): LoopGuardDetection | undefined {
	const last = records[records.length - 1];
	if (last === undefined) return undefined;
	let run = 1;
	for (let i = records.length - 2; i >= 0; i--) {
		if (records[i]?.signature !== last.signature) break;
		run++;
	}
	if (run < IDENTICAL_RUN_THRESHOLD) return undefined;
	return { kind: "identical", toolName: last.toolName, count: run, fingerprint: last.signature };
}

export function detectSimilarRun(records: readonly ToolCallRecord[]): LoopGuardDetection | undefined {
	const last = records[records.length - 1];
	if (last === undefined) return undefined;
	let run = 1;
	for (let i = records.length - 2; i >= 0; i--) {
		if (records[i]?.toolName !== last.toolName) break;
		run++;
	}
	if (run < SIMILAR_RUN_THRESHOLD) return undefined;
	const argStrings = records.slice(records.length - run).map((record) => record.argsJson);
	if (new Set(argStrings).size === 1) return undefined;
	const similarity = meanAdjacentSimilarity(argStrings);
	if (similarity < SIMILARITY_THRESHOLD) return undefined;
	return { kind: "similar", toolName: last.toolName, count: run, similarity, fingerprint: last.toolName };
}

export function detectCycle(records: readonly ToolCallRecord[]): LoopGuardDetection | undefined {
	const total = records.length;
	for (let period = CYCLE_MIN_PERIOD; period <= CYCLE_MAX_PERIOD; period++) {
		if (total < period * CYCLE_REPETITION_THRESHOLD) continue;
		const cycle = records.slice(total - period);
		if (new Set(cycle.map((record) => record.signature)).size < 2) continue;
		let repetitions = 1;
		while (repetitions * period + period <= total) {
			const blockStart = total - (repetitions + 1) * period;
			let matches = true;
			for (let offset = 0; offset < period; offset++) {
				if (records[blockStart + offset]?.signature !== cycle[offset]?.signature) {
					matches = false;
					break;
				}
			}
			if (!matches) break;
			repetitions++;
		}
		if (repetitions < CYCLE_REPETITION_THRESHOLD) continue;
		return {
			kind: "cycle",
			period,
			count: repetitions,
			cycleTools: cycle.map((record) => record.toolName),
			fingerprint: cycle.map((record) => record.signature).join("\u0001"),
		};
	}
	return undefined;
}

interface GateEntry {
	fingerprint: string;
	lastNotifiedCount: number;
}

export class NoticeGate {
	private entries = new Map<LoopGuardKind, GateEntry>();

	admit(detection: LoopGuardDetection): boolean {
		const existing = this.entries.get(detection.kind);
		if (existing === undefined || existing.fingerprint !== detection.fingerprint) {
			this.entries.set(detection.kind, { fingerprint: detection.fingerprint, lastNotifiedCount: detection.count });
			return true;
		}
		if (detection.count >= existing.lastNotifiedCount * ESCALATION_FACTOR) {
			existing.lastNotifiedCount = detection.count;
			return true;
		}
		return false;
	}

	prune(active: ReadonlyMap<LoopGuardKind, string>): void {
		for (const [kind, entry] of this.entries) {
			if (active.get(kind) !== entry.fingerprint) this.entries.delete(kind);
		}
	}

	reset(): void {
		this.entries.clear();
	}
}

export function detectLoop(records: readonly ToolCallRecord[], gate: NoticeGate): LoopGuardDetection | undefined {
	const detections = [detectIdenticalRun(records), detectCycle(records), detectSimilarRun(records)];
	const active = new Map<LoopGuardKind, string>();
	for (const detection of detections) {
		if (detection !== undefined) active.set(detection.kind, detection.fingerprint);
	}
	gate.prune(active);
	for (const detection of detections) {
		if (detection !== undefined && gate.admit(detection)) return detection;
	}
	return undefined;
}
