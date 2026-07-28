import type { Api, Model, ProviderEnv } from "@earendil-works/pi-ai";
import { resolvePromptCacheTtlSeconds } from "@earendil-works/pi-ai";
import type { PromptCacheSettings } from "./settings-manager.ts";

/** Headroom subtracted from the model's prompt-cache TTL, so a wait never straddles cache expiry. */
export const DEFAULT_PROMPT_CACHE_SAFETY_BUFFER_SECONDS = 30;

/** Advisory out-of-process mirror of the resolved budget; absent means "no budget". */
export const PROMPT_CACHE_SAFE_WAIT_ENV = "PI_PROMPT_CACHE_SAFE_WAIT_SECONDS";

/**
 * `pi-ai` provider env is a plain string map, while `process.env` values are
 * optional. Drop the undefined entries at this boundary instead of casting.
 */
function toProviderEnv(env: NodeJS.ProcessEnv): ProviderEnv {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) resolved[key] = value;
	}
	return resolved;
}

function resolveBufferSeconds(configured: number | undefined): number {
	if (configured === undefined) return DEFAULT_PROMPT_CACHE_SAFETY_BUFFER_SECONDS;
	if (!Number.isFinite(configured) || configured < 0) return DEFAULT_PROMPT_CACHE_SAFETY_BUFFER_SECONDS;
	return Math.trunc(configured);
}

/**
 * Longest a tool may block in the foreground without risking prompt-cache
 * expiry: the active model's cache TTL minus a safety buffer.
 *
 * `undefined` means "no cache-derived budget" — the TTL is unknown, caching is
 * off, the feature is disabled, or the buffer swallows the whole TTL. Callers
 * treat that as today's unbounded behavior.
 */
export function resolvePromptCacheSafeWaitSeconds(
	model: Model<Api> | undefined,
	settings: PromptCacheSettings | undefined,
	env: NodeJS.ProcessEnv,
): number | undefined {
	if (settings?.cacheAwareTimeouts === false) return undefined;
	if (!model) return undefined;
	const ttlSeconds = resolvePromptCacheTtlSeconds(model, toProviderEnv(env));
	if (ttlSeconds === undefined) return undefined;
	const safeWait = ttlSeconds - resolveBufferSeconds(settings?.safetyBufferSeconds);
	return safeWait >= 1 ? safeWait : undefined;
}
