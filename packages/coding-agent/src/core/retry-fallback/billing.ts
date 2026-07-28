/**
 * Billing-class provider failures (credit exhaustion, hard account quota).
 * These never recover by retrying the same account, so the fallback switch for
 * one is always pinned: the candidate becomes the session model for the rest of
 * the session instead of reverting after the billing cooldown.
 */
const BILLING_ERROR_PATTERN = /credit[- ]balance|insufficient[_ -]quota|\bbilling\b|purchase credits/i;

export function isBillingErrorMessage(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && BILLING_ERROR_PATTERN.test(errorMessage);
}
