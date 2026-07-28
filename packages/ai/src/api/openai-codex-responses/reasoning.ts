export type CodexReasoningSummary = "auto" | "concise" | "detailed";
export interface CodexReasoning {
	effort?: string;
	summary?: CodexReasoningSummary;
}

/** @deprecated Pass `null` to omit reasoning summaries. */
type LegacyCodexReasoningSummaryOff = "off";

/** @deprecated Pass `"auto"` to request the default reasoning summary. */
type LegacyCodexReasoningSummaryOn = "on";

export type CodexReasoningSummaryInput =
	| CodexReasoningSummary
	| LegacyCodexReasoningSummaryOff
	| LegacyCodexReasoningSummaryOn
	| null;

export function normalizeCodexReasoningSummary(
	reasoningSummary: CodexReasoningSummaryInput | undefined,
): CodexReasoningSummary | undefined {
	switch (reasoningSummary) {
		case null:
		case "off":
			return undefined;
		case undefined:
		case "on":
			return "auto";
		default:
			return reasoningSummary;
	}
}

export function buildCodexReasoning(
	reasoningEffort: string | null | undefined,
	reasoningSummary: CodexReasoningSummaryInput | undefined,
	modelSupportsReasoning: boolean,
	thinkingOff: string | null | undefined,
): CodexReasoning | undefined {
	let effort: string;
	if (reasoningEffort !== undefined && reasoningEffort !== null) {
		effort = reasoningEffort;
	} else if (reasoningEffort === undefined && modelSupportsReasoning && thinkingOff !== null) {
		effort = thinkingOff ?? "none";
	} else {
		return undefined;
	}

	const summary = normalizeCodexReasoningSummary(reasoningSummary);
	return { effort, ...(summary === undefined ? {} : { summary }) };
}
