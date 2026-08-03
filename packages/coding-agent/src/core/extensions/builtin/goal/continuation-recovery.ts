export const CONTINUATION_CAP_BLOCKED_REASON = "continuation cap reached";
export const REPETITION_BLOCKED_REASON = "repeated assistant output";
export const LENGTH_EXHAUSTED_BLOCKED_REASON = "output truncation repeated";

const MECHANICAL_CONTINUATION_BLOCKS: readonly string[] = [
	CONTINUATION_CAP_BLOCKED_REASON,
	REPETITION_BLOCKED_REASON,
	LENGTH_EXHAUSTED_BLOCKED_REASON,
];

const RESUME_GUIDANCE = "Send any message to resume.";

export function isMechanicalContinuationBlock(blockedReason: string | undefined): boolean {
	if (blockedReason === undefined) return false;
	return MECHANICAL_CONTINUATION_BLOCKS.includes(blockedReason);
}

export function continuationCapRecoveryHint(blockedReason: string): string {
	if (!isMechanicalContinuationBlock(blockedReason)) return `Goal continuation blocked: ${blockedReason}`;
	return `Goal continuation blocked: ${blockedReason}. ${RESUME_GUIDANCE}`;
}
