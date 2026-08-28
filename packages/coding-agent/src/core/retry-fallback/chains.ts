import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isValidThinkingLevel } from "../../cli/args.ts";
import { findExactModelReferenceMatch, parseModelPattern } from "../model-resolver.ts";
import { type FallbackAuthTiers, MAX_PROVIDERS_PER_FAMILY, parseBareSelector, rankFamilyModels } from "./expansion.ts";

export interface FallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

export type FallbackChains = Readonly<Record<string, readonly string[]>>;

export type FallbackModelLookup =
	| readonly Model<Api>[]
	| {
			getAll(): Model<Api>[];
			isUsingOAuth?(model: Model<Api>): boolean;
			hasConfiguredAuth?(model: Model<Api>): boolean;
			isFallbackEligible?(model: Model<Api>): boolean;
	  };

function availableModels(lookup: FallbackModelLookup): Model<Api>[] {
	return "getAll" in lookup ? lookup.getAll() : [...lookup];
}

/**
 * Auth tier is optional so array lookups and older callers keep working; without
 * it every provider lands in the non-OAuth tier and the precedence table decides.
 */
function authTiers(lookup: FallbackModelLookup): FallbackAuthTiers {
	if (Array.isArray(lookup)) return { isUsingOAuth: () => false };
	const registry = lookup as {
		isUsingOAuth?(model: Model<Api>): boolean;
		hasConfiguredAuth?(model: Model<Api>): boolean;
		isFallbackEligible?(model: Model<Api>): boolean;
	};
	return {
		isUsingOAuth: (model) => registry.isUsingOAuth?.(model) === true,
		hasConfiguredAuth:
			typeof registry.hasConfiguredAuth === "function"
				? (model) => registry.hasConfiguredAuth?.(model) === true
				: undefined,
		isFallbackEligible:
			typeof registry.isFallbackEligible === "function"
				? (model) => registry.isFallbackEligible?.(model) !== false
				: undefined,
	};
}

/** An empty entry list is the documented opt-out; it survives as a tombstone. */
export function isChainTombstone(entries: readonly string[] | undefined): boolean {
	return Array.isArray(entries) && entries.length === 0;
}

function selectorReference(raw: string): { reference: string; thinkingLevel?: ThinkingLevel } | undefined {
	const trimmed = raw.trim();
	if (!trimmed.includes("/") || trimmed.includes("*")) return undefined;

	const lastColon = trimmed.lastIndexOf(":");
	if (lastColon === -1) return { reference: trimmed };

	const prefix = trimmed.slice(0, lastColon);
	const suffix = trimmed.slice(lastColon + 1).toLowerCase();
	if (!isValidThinkingLevel(suffix)) return { reference: trimmed };
	return { reference: prefix, thinkingLevel: suffix };
}

/**
 * Resolves only complete provider/model selectors. The full input is resolved first
 * so colons belonging to a model id remain part of that id; aliases then resolve
 * against the model-id portion while retaining the explicitly selected provider.
 */
export function parseFallbackSelector(raw: string, lookup: FallbackModelLookup): FallbackSelector | undefined {
	const models = availableModels(lookup);
	const trimmed = raw.trim();
	const parsedReference = selectorReference(trimmed);
	if (!parsedReference) return undefined;

	const fullMatch = findExactModelReferenceMatch(trimmed, models);
	if (fullMatch) {
		return { raw: trimmed, provider: fullMatch.provider, id: fullMatch.id };
	}

	const slashIndex = parsedReference.reference.indexOf("/");
	const provider = parsedReference.reference.slice(0, slashIndex).trim();
	const modelPattern = parsedReference.reference.slice(slashIndex + 1).trim();
	if (!provider || !modelPattern) return undefined;

	// The provider is explicit, so resolve the id pattern inside that provider only.
	// A global lookup lets foreign ids containing the pattern (e.g. Bedrock's
	// "us.anthropic.claude-opus-5") win over the requested provider's exact id.
	const providerModels = models.filter((model) => model.provider.toLowerCase() === provider.toLowerCase());
	const parsed = parseModelPattern(
		parsedReference.thinkingLevel ? `${modelPattern}:${parsedReference.thinkingLevel}` : modelPattern,
		providerModels,
		{ allowInvalidThinkingLevelFallback: false },
	);
	if (!parsed.model || parsed.warning) return undefined;
	if (parsedReference.thinkingLevel && !parsed.thinkingLevel) return undefined;

	return {
		raw: trimmed,
		provider: parsed.model.provider,
		id: parsed.model.id,
		thinkingLevel: parsed.thinkingLevel,
	};
}

export function formatSelector(model: Model<Api>, thinkingLevel?: ThinkingLevel): string {
	const base = `${model.provider}/${model.id}`;
	return thinkingLevel ? `${base}:${thinkingLevel}` : base;
}

export function baseSelector(selector: Pick<FallbackSelector, "provider" | "id">): string {
	return `${selector.provider}/${selector.id}`;
}

/**
 * Converts validated configuration to canonical selector strings for runtime lookup.
 *
 * A bare key (no provider prefix) is a model-family policy: it expands to one
 * canonical key per provider serving that family, so a chain shipped for
 * `claude-fable-5` applies no matter which provider the user attached it through.
 * Provider-qualified keys and entries keep exact semantics, and an explicit key
 * always overrides the expansion it collides with.
 */
/**
 * Chain key matched when no exact or base key resolves for the current model.
 * Exists so a model without its own configured chain still has an escape lane:
 * without it, a hard-failing upstream wedges the session terminal even though
 * healthy fallback targets exist (desktop thread 487d7c29, 2026-08-28: nine
 * consecutive upstream 500s, zero fallback attempts, terminal error).
 * Users disable it with the `"*": []` tombstone.
 */
export const WILDCARD_CHAIN_KEY = "*";

/**
 * Whether the user explicitly switched fallback OFF for this model with the
 * documented `[]` tombstone (exact key, base key, or a bare family key that
 * covers it). The shipped wildcard lane must never resurrect fallback against
 * that instruction, so the wildcard gate consults this first.
 *
 * Bare-family matching is deliberately conservative: an ambiguous match
 * suppresses the wildcard rather than overriding an explicit opt-out, because a
 * surprising extra fallback hop is worse than a missing convenience lane.
 */
export function hasExplicitFallbackOptOut(
	chains: FallbackChains,
	currentModel: Model<Api>,
	currentThinking: ThinkingLevel | undefined,
): boolean {
	const base = formatSelector(currentModel).toLowerCase();
	const exact = currentThinking ? `${base}:${currentThinking}`.toLowerCase() : base;
	const modelId = currentModel.id.toLowerCase();
	for (const [key, entries] of Object.entries(chains)) {
		if (!Array.isArray(entries) || !isChainTombstone(entries)) continue;
		if (key === WILDCARD_CHAIN_KEY) continue;
		const normalizedKey = key.trim().toLowerCase();
		const keyBase = normalizedBase(normalizedKey);
		if (keyBase === base || normalizedKey === exact) return true;
		// Bare family key (no provider prefix): treat an id match as covering.
		if (!normalizedKey.includes("/") && (keyBase === modelId || modelId.startsWith(`${keyBase}-`))) return true;
	}
	return false;
}

export function canonicalizeFallbackChains(chains: FallbackChains, lookup: FallbackModelLookup): FallbackChains {
	const models = availableModels(lookup);
	const tiers = authTiers(lookup);
	const canonical: Record<string, readonly string[]> = {};
	const explicitKeys = new Set<string>();
	const tombstones = new Set<string>();

	const expandEntries = (entries: readonly string[], keySelector: string): string[] =>
		entries.flatMap((entry) => {
			const bare = parseBareSelector(entry);
			if (bare) {
				return rankFamilyModels(models, bare.family, tiers, { limit: MAX_PROVIDERS_PER_FAMILY })
					.map((model) =>
						bare.thinkingLevel ? `${formatSelector(model)}:${bare.thinkingLevel}` : formatSelector(model),
					)
					.filter((selector) => normalizedBase(selector) !== normalizedBase(keySelector));
			}
			const parsedEntry = parseFallbackSelector(entry, models);
			return parsedEntry ? [formatParsedSelector(parsedEntry)] : [];
		});

	// Bare keys expand first so a same-named explicit key can overwrite them.
	for (const [key, entries] of Object.entries(chains)) {
		const bareKey = parseBareSelector(key);
		if (!bareKey || !Array.isArray(entries)) continue;
		if (isChainTombstone(entries)) {
			for (const model of rankFamilyModels(models, bareKey.family, tiers)) {
				tombstones.add(formatSelector(model).toLowerCase());
			}
			continue;
		}
		for (const model of rankFamilyModels(models, bareKey.family, tiers)) {
			const keySelector = bareKey.thinkingLevel
				? `${formatSelector(model)}:${bareKey.thinkingLevel}`
				: formatSelector(model);
			const canonicalEntries = expandEntries(entries, keySelector);
			if (canonicalEntries.length > 0) canonical[keySelector] = canonicalEntries;
		}
	}

	for (const [key, entries] of Object.entries(chains)) {
		if (parseBareSelector(key)) continue;
		const parsedKey = parseFallbackSelector(key, models);
		if (!parsedKey || !Array.isArray(entries)) continue;
		const keySelector = formatParsedSelector(parsedKey);
		if (isChainTombstone(entries)) {
			tombstones.add(normalizedBase(keySelector));
			continue;
		}
		explicitKeys.add(keySelector.toLowerCase());
		const canonicalEntries = expandEntries(entries, keySelector);
		if (canonicalEntries.length > 0) canonical[keySelector] = canonicalEntries;
	}

	for (const key of Object.keys(canonical)) {
		if (explicitKeys.has(key.toLowerCase())) continue;
		if (tombstones.has(normalizedBase(key))) delete canonical[key];
	}

	// The wildcard key is not a model selector, so both loops above skip it.
	// Its entries expand exactly like any other chain; a `[]` tombstone removes
	// the lane entirely. Self-selection of the failing model is prevented at
	// candidate time (nextCandidate's "self" skip), not here, because the
	// wildcard has no key selector to filter against.
	const wildcardEntries = chains[WILDCARD_CHAIN_KEY];
	if (Array.isArray(wildcardEntries) && !isChainTombstone(wildcardEntries)) {
		const canonicalEntries = expandEntries(wildcardEntries, WILDCARD_CHAIN_KEY);
		if (canonicalEntries.length > 0) canonical[WILDCARD_CHAIN_KEY] = canonicalEntries;
	}

	return canonical;
}

export function resolveChainKey(
	currentModel: Model<Api>,
	currentThinking: ThinkingLevel | undefined,
	chains: FallbackChains,
	options?: { allowWildcard?: boolean },
): string | undefined {
	const base = formatSelector(currentModel);
	const exact = currentThinking ? `${base}:${currentThinking}` : base;
	if (Object.hasOwn(chains, exact)) return exact;
	if (Object.hasOwn(chains, base)) return base;
	// The wildcard is opt-in per call site: it is a last resort for a model with
	// no chain of its own, and it must never hijack a session already walking a
	// configured chain (the last rung of that chain usually has no key either).
	// nextCandidate consults the active episode's chainKey before asking for it.
	if (!options?.allowWildcard) return undefined;
	return Object.hasOwn(chains, WILDCARD_CHAIN_KEY) ? WILDCARD_CHAIN_KEY : undefined;
}

function formatParsedSelector(selector: FallbackSelector): string {
	const base = baseSelector(selector);
	return selector.thinkingLevel ? `${base}:${selector.thinkingLevel}` : base;
}

function normalizedBase(selector: FallbackSelector | string): string {
	if (typeof selector !== "string") return baseSelector(selector).toLowerCase();

	const normalized = selector.trim().toLowerCase();
	const lastColon = normalized.lastIndexOf(":");
	if (lastColon === -1 || !isValidThinkingLevel(normalized.slice(lastColon + 1))) return normalized;
	return normalized.slice(0, lastColon);
}

function normalizedExact(selector: FallbackSelector | string): string {
	return typeof selector === "string" ? selector.trim().toLowerCase() : formatParsedSelector(selector).toLowerCase();
}

/**
 * Returns entries after the current fallback. A primary or unknown selector starts
 * from the beginning, which also makes re-entry after stale runtime state safe.
 */
export function candidatesAfter(
	chainEntries: readonly string[],
	currentSelector: FallbackSelector | string,
): readonly string[] {
	const exact = normalizedExact(currentSelector);
	const exactIndex = chainEntries.findIndex((entry) => entry.toLowerCase() === exact);
	if (exactIndex !== -1) return chainEntries.slice(exactIndex + 1);

	const base = normalizedBase(currentSelector);
	const baseIndex = chainEntries.findIndex((entry) => normalizedBase(entry) === base);
	return baseIndex === -1 ? chainEntries : chainEntries.slice(baseIndex + 1);
}
