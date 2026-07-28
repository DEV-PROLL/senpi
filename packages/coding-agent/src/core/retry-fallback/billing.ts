/**
 * Billing-class provider failures (credit exhaustion, hard account quota).
 * These never recover by retrying the same model, so `retry.billingErrorPolicy`
 * can promote the fallback switch to a permanent session-level model swap.
 */
const BILLING_ERROR_PATTERN = /credit[- ]balance|insufficient[_ -]quota|\bbilling\b|purchase credits/i;

export function isBillingErrorMessage(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && BILLING_ERROR_PATTERN.test(errorMessage);
}
