import { isRetryableErrorMessage } from "../retry.ts";
import type { RetryClassification, RetryClassifier, RetryFailure } from "./types.ts";

/**
 * Status codes Kimi's provider-request stage treats as retryable. 429 is its
 * own `rate-limited` verdict (the turn budget treats it through hint tiers);
 * the other whitelisted codes are ordinary `transient`. Every other status —
 * client errors and non-whitelisted 5xx alike — is `terminal`.
 */
const KIMI_RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function classifyKimiHttpStatus(statusCode: number | undefined): RetryClassification {
	if (statusCode === undefined || !KIMI_RETRYABLE_STATUS_CODES.has(statusCode)) {
		return { verdict: "terminal" };
	}
	return statusCode === 429 ? { verdict: "rate-limited" } : { verdict: "transient" };
}

function assertNever(kind: never): never {
	throw new Error(`Unhandled retry failure kind: ${kind}`);
}

/**
 * Kimi provider-request classifier, ported from the source provider's retry
 * policy (policy only, not its code). The switch is exhaustive over
 * {@link RetryFailure}["kind"]:
 *
 * - abort / refusal / sensitive / quota-exhausted / image-format / unknown are
 *   terminal: user cancellations, content refusals, dead accounts, rejected
 *   payloads, and unrecognized failures never recover by re-sending.
 * - connection / timeout / provider failures are transient transport noise.
 * - empty-response is transient unless the model said `finishReason` was
 *   "filtered", which is a deterministic content rejection.
 * - http-status is retryable only for the whitelisted codes above.
 */
export const classifyKimiFailure: RetryClassifier = (failure) => {
	switch (failure.kind) {
		case "abort":
		case "refusal":
		case "sensitive":
		case "quota-exhausted":
		case "image-format":
		case "unknown":
			return { verdict: "terminal" };
		case "connection":
		case "timeout":
		case "provider":
			return { verdict: "transient" };
		case "empty-response":
			return failure.finishReason === "filtered" ? { verdict: "terminal" } : { verdict: "transient" };
		case "http-status":
			return classifyKimiHttpStatus(failure.statusCode);
		default:
			return assertNever(failure.kind);
	}
};

/**
 * Senpi assistant-turn classifier: a pure delegation to the existing message
 * classifier. The regexes (and their non-retryable-wins precedence) stay
 * owned by `../retry.ts`; this adapter only maps its boolean onto the stage
 * classification union.
 *
 * Known, accepted divergence from {@link classifyKimiFailure}: a 500 carrying
 * invalid-tool-schema text is `transient` under Kimi's status table (the
 * whitelisted status decides alone) but `terminal` here (the request-shape
 * patterns outrank any status wording). The source policy requires both.
 */
export const classifySenpiAssistantFailure: RetryClassifier = (failure) =>
	isRetryableErrorMessage(failure.message) ? { verdict: "transient" } : { verdict: "terminal" };
