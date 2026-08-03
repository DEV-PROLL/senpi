import { AllAccountsBlockedError } from "./affinity.ts";
import { classifySdkError } from "./errors.ts";
import { allAccountsBlockedGuidance, sdkErrorGuidance } from "./guidance.ts";

export function withAuthGuidance(error: unknown, message: string): string {
	if (error instanceof AllAccountsBlockedError) return allAccountsBlockedGuidance(error.soonestUnblockAt);
	const guidance = sdkErrorGuidance(classifySdkError(error).kind);
	return guidance ? `${message}\n${guidance}` : message;
}
