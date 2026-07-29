import type { Api, Model, ProviderEnv } from "@earendil-works/pi-ai";
import { resolvePromptCacheTtlSeconds } from "@earendil-works/pi-ai";
import type { TokenUsageSnapshot } from "./types.ts";

/** Custom session-entry type carrying the cache-warm continuation story. */
export const GOAL_CACHE_WARMUP_ENTRY_TYPE = "goal-cache-warmup";

/** Cache context captured when a monitor-wait continuation is scheduled. */
export interface GoalCacheWarmMetrics {
	/** Prompt-cache TTL of the active model in seconds, when known. */
	readonly ttlSeconds?: number;
	/** Tokens sitting warm in the provider prompt cache after the last turn. */
	readonly cachedTokens: number;
	/** Estimated USD saved by re-reading those tokens from cache instead of paying a cold input read. */
	readonly estimatedSavedUsd?: number;
}

export type GoalCacheWarmupPhase = "scheduled" | "resumed";

/**
 * Durable payload appended as a `goal-cache-warmup` custom entry and carried by
 * the `goal_continuation_scheduled` / `goal_continuation_resumed` pi-events, so
 * external consumers (for example omo-desktop-app) can render the story later.
 */
export interface GoalCacheWarmupEntryData {
	readonly phase: GoalCacheWarmupPhase;
	readonly goalId: string;
	/** Planned continuation delay in milliseconds. */
	readonly delayMs: number;
	/** Actual wait in milliseconds; present on the `resumed` phase only. */
	readonly waitedMs?: number;
	readonly activeMonitorCount: number;
	readonly cache?: GoalCacheWarmMetrics;
}

const TOKENS_PER_PRICE_UNIT = 1_000_000;

export function estimateCacheWarmMetrics(
	model: Model<Api> | undefined,
	env: NodeJS.ProcessEnv,
	lastTurnUsage: Pick<TokenUsageSnapshot, "cacheRead" | "cacheWrite"> | undefined,
): GoalCacheWarmMetrics | undefined {
	const cachedTokens = clampTokens(lastTurnUsage?.cacheRead) + clampTokens(lastTurnUsage?.cacheWrite);
	const ttlSeconds = model === undefined ? undefined : resolvePromptCacheTtlSeconds(model, toProviderEnv(env));
	if (ttlSeconds === undefined && cachedTokens === 0) return undefined;
	const estimatedSavedUsd =
		model !== undefined && cachedTokens > 0
			? (Math.max(0, model.cost.input - model.cost.cacheRead) * cachedTokens) / TOKENS_PER_PRICE_UNIT
			: undefined;
	return {
		cachedTokens,
		...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
		...(estimatedSavedUsd !== undefined ? { estimatedSavedUsd } : {}),
	};
}

export function buildCacheWarmScheduledNotice(
	delayMs: number,
	activeMonitorCount: number,
	cache: GoalCacheWarmMetrics | undefined,
): string {
	const base = `${monitorsOnDuty(activeMonitorCount)} - goal continuation deferred ${formatDeferredDelay(delayMs)}`;
	if (cache === undefined || cache.cachedTokens <= 0) {
		return `${base} so the monitor can wake us the moment decisive output lands.`;
	}
	const warmTokens = `~${formatWarmTokenCount(cache.cachedTokens)} tokens`;
	if (cache.ttlSeconds === undefined) {
		return `${base}. The timed wake keeps ${warmTokens} warm instead of re-paying a cold read.`;
	}
	return `${base}. The timed wake stays inside the ${formatCacheTtl(cache.ttlSeconds)} prompt-cache TTL, keeping ${warmTokens} warm instead of re-paying a cold read.`;
}

export function buildCacheWarmResumedNotice(
	waitedMs: number,
	activeMonitorCount: number,
	cache: GoalCacheWarmMetrics | undefined,
): string {
	const stillOnDuty =
		activeMonitorCount === 1 ? "1 monitor still on duty" : `${activeMonitorCount} monitors still on duty`;
	const head = `Cache-warm wake after ${formatWakeDuration(waitedMs)} - ${stillOnDuty}.`;
	if (cache === undefined || cache.cachedTokens <= 0) return `${head} Continuing the goal.`;
	const savings =
		cache.estimatedSavedUsd !== undefined && cache.estimatedSavedUsd > 0
			? ` (est. ${formatSavedUsd(cache.estimatedSavedUsd)} saved vs a cold re-read)`
			: "";
	return `${head} ~${formatWarmTokenCount(cache.cachedTokens)} tokens stayed warm in the prompt cache${savings}. Continuing the goal.`;
}

export function formatWarmTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${trimTrailingZero((tokens / 1_000_000).toFixed(1))}M`;
	if (tokens >= 1000) return `${trimTrailingZero((tokens / 1000).toFixed(1))}K`;
	return String(Math.max(0, Math.trunc(tokens)));
}

export function formatWakeDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const restSeconds = seconds % 60;
	if (minutes < 60) return restSeconds === 0 ? `${minutes}m` : `${minutes}m ${restSeconds}s`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

export function formatCacheTtl(seconds: number): string {
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

export function formatSavedUsd(value: number): string {
	if (value < 0.0005) return "<$0.001";
	if (value < 1) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(2)}`;
}

function monitorsOnDuty(count: number): string {
	return count === 1 ? "1 monitor on duty" : `${count} monitors on duty`;
}

function formatDeferredDelay(delayMs: number): string {
	const seconds = Math.round(delayMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const restSeconds = seconds % 60;
	if (restSeconds === 0) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
	return `${minutes}m ${restSeconds}s`;
}

function trimTrailingZero(value: string): string {
	return value.endsWith(".0") ? value.slice(0, -2) : value;
}

function clampTokens(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function toProviderEnv(env: NodeJS.ProcessEnv): ProviderEnv {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) resolved[key] = value;
	}
	return resolved;
}
