import type { AgentToolResult } from "@code-yeongyu/senpi";
import { capCodePoints, MAX_ENRICHED_TOOL_CALLS } from "./call-capture.ts";
import type { CellState } from "./cell-runtime.ts";
import type { EvalLanguage, EvalToolCallSummary, EvalToolDetails } from "./types.ts";

export const EVAL_EXECUTION_EVENT = "senpi.eval.execution";

export interface EvalToolAggregate {
	readonly count: number;
	readonly totalDurationMs: number;
	readonly okCount: number;
	readonly errorCount: number;
}

export type EvalToolAggregates = Record<string, EvalToolAggregate>;

export interface EvalExecutionEventPayload {
	readonly version: 1;
	readonly cellId: string;
	readonly language: EvalLanguage;
	readonly ok: boolean;
	readonly error?: string;
	readonly startedAt: number;
	readonly completedAt: number;
	readonly durationMs: number;
	readonly detached: boolean;
	readonly toolCallCount: number;
	readonly toolCalls: readonly EvalToolCallSummary[];
	readonly distinctToolsCalled: readonly string[];
	readonly toolAggregates: EvalToolAggregates;
}

export type EvalExecutionSettleOutcome =
	| { readonly result: AgentToolResult<EvalToolDetails> }
	| { readonly error: unknown };

export interface BuildEvalExecutionEventPayloadOptions {
	readonly cellId: string;
	readonly state: CellState;
	readonly outcome: EvalExecutionSettleOutcome;
	readonly completedAt: number;
	readonly detached: boolean;
}

export function buildEvalExecutionEventPayload(
	options: BuildEvalExecutionEventPayloadOptions,
): EvalExecutionEventPayload {
	const { cellId, state, outcome, completedAt, detached } = options;
	const result = "result" in outcome ? outcome.result : undefined;
	const ok = result?.details.isError !== true && !("error" in outcome);
	const aggregates = new Map<string, EvalToolAggregate>();

	for (const call of state.toolCalls) {
		const current = aggregates.get(call.name) ?? {
			count: 0,
			totalDurationMs: 0,
			okCount: 0,
			errorCount: 0,
		};
		aggregates.set(call.name, {
			count: current.count + 1,
			totalDurationMs: current.totalDurationMs + (call.durationMs ?? 0),
			okCount: current.okCount + (call.ok ? 1 : 0),
			errorCount: current.errorCount + (call.ok ? 0 : 1),
		});
	}

	const error = ok ? undefined : settleError(state, outcome);
	return {
		version: 1,
		cellId,
		language: state.input.language,
		ok,
		...(error === undefined ? {} : { error: capCodePoints(error, 512) }),
		startedAt: state.startedAt,
		completedAt,
		durationMs: result?.details.durationMs ?? Math.max(0, completedAt - state.startedAt),
		detached,
		toolCallCount: state.toolCalls.length,
		toolCalls: state.toolCalls.slice(0, MAX_ENRICHED_TOOL_CALLS),
		distinctToolsCalled: [...aggregates.keys()],
		toolAggregates: Object.fromEntries(aggregates),
	};
}

function settleError(state: CellState, outcome: EvalExecutionSettleOutcome): string | undefined {
	if (state.error !== undefined) return state.error;
	if ("error" in outcome) return outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
	for (const part of outcome.result.content) {
		if (part.type === "text" && part.text.length > 0) return part.text.trimEnd();
	}
	return undefined;
}
