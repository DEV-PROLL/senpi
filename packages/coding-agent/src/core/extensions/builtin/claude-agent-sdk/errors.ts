import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";

export type SdkErrorKind = "rate_limit" | "overloaded" | "auth_error" | "billing" | "org_not_allowed" | "other";

export type SdkErrorClassification = {
	kind: SdkErrorKind;
	retryable: boolean;
};

const SDK_ERROR_CLASSIFICATIONS: Partial<Record<SDKAssistantMessageError, SdkErrorClassification>> = {
	authentication_failed: { kind: "auth_error", retryable: true },
	oauth_org_not_allowed: { kind: "org_not_allowed", retryable: false },
	billing_error: { kind: "billing", retryable: false },
	rate_limit: { kind: "rate_limit", retryable: true },
	overloaded: { kind: "overloaded", retryable: true },
	invalid_request: { kind: "other", retryable: false },
	server_error: { kind: "other", retryable: true },
};

const OTHER_ERROR: SdkErrorClassification = { kind: "other", retryable: false };

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function errorText(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	const value = record(error);
	if (!value) return String(error);
	const message = value.message;
	if (typeof message === "string") return message;
	const code = value.error;
	if (typeof code === "string") return code;
	return String(error);
}

/** Classifies Claude Agent SDK error codes and HTTP-shaped fallback text in one place. */
export function classifySdkError(error: unknown): SdkErrorClassification {
	const text = errorText(error).toLowerCase();
	for (const [code, classification] of Object.entries(SDK_ERROR_CLASSIFICATIONS)) {
		if (new RegExp(`\\b${code}\\b`).test(text)) return classification;
	}
	if (/\b(?:http\s*)?429\b|too many requests|rate[ _-]?limit/.test(text)) {
		return { kind: "rate_limit", retryable: true };
	}
	if (/\b(?:http\s*)?529\b|overloaded/.test(text)) return { kind: "overloaded", retryable: true };
	return OTHER_ERROR;
}
