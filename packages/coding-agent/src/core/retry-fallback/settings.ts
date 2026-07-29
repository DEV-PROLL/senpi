import type { FallbackChains } from "./chains.ts";

export interface ProviderRetrySettings {
	timeoutMs?: number;
	streamStartTimeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
}

export interface RetrySettings {
	enabled?: boolean;
	maxRetries?: number;
	baseDelayMs?: number;
	provider?: ProviderRetrySettings;
	modelFallback?: boolean;
	fallbackChains?: Record<string, string[]>;
	fallbackRevertPolicy?: "cooldown-expiry" | "never";
	abortServerSideFallback?: boolean;
}

export interface ResolvedRetryFallbackSettings {
	modelFallback: boolean;
	chains: FallbackChains;
	revertPolicy: "cooldown-expiry" | "never";
}

export const DEFAULT_FALLBACK_CHAINS: FallbackChains = {
	"anthropic/claude-fable-5": [
		"apitopia/kimi-k3-unlocked:max",
		"anthropic/claude-opus-5:xhigh",
		"anthropic/claude-opus-4-8:xhigh",
	],
};

function cloneDefaultFallbackChains(): Record<string, readonly string[]> {
	const chains: Record<string, readonly string[]> = {};
	for (const [key, entries] of Object.entries(DEFAULT_FALLBACK_CHAINS)) {
		chains[key] = [...entries];
	}
	return chains;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function resolveFallbackChains(value: unknown): FallbackChains {
	if (value === undefined) return cloneDefaultFallbackChains();
	if (!isPlainObject(value)) return cloneDefaultFallbackChains();

	const chains: Record<string, readonly string[]> = {};
	for (const [key, entries] of Object.entries(value)) {
		if (!isStringArray(entries)) return cloneDefaultFallbackChains();
		chains[key] = [...entries];
	}
	return chains;
}

export function resolveRetryFallbackSettings(settings: RetrySettings | undefined): ResolvedRetryFallbackSettings {
	return {
		modelFallback: typeof settings?.modelFallback === "boolean" ? settings.modelFallback : true,
		chains: resolveFallbackChains(settings?.fallbackChains),
		revertPolicy: settings?.fallbackRevertPolicy === "never" ? "never" : "cooldown-expiry",
	};
}

export function resolveAbortServerSideFallback(settings: RetrySettings | undefined): boolean {
	return typeof settings?.abortServerSideFallback === "boolean" ? settings.abortServerSideFallback : true;
}
