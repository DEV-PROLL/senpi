import { canonicalizeFallbackChains, type FallbackModelLookup } from "../../../retry-fallback/chains.ts";
import type { ExtensionSessionSettings, RetryFallbackSettings } from "../../types.ts";

export type FallbackSettings = RetryFallbackSettings;

function withAvailableChains(settings: FallbackSettings, models: FallbackModelLookup): FallbackSettings {
	return {
		...settings,
		chains: canonicalizeFallbackChains(settings.chains, models),
	};
}

export function loadFallbackSettings(
	settings: ExtensionSessionSettings,
	models: FallbackModelLookup,
): FallbackSettings {
	return withAvailableChains(settings.getRetryFallbackSettings(), models);
}

export async function updateFallbackSettings(
	settings: ExtensionSessionSettings,
	models: FallbackModelLookup,
	update: (settings: ExtensionSessionSettings) => Promise<void>,
): Promise<FallbackSettings> {
	await update(settings);
	return withAvailableChains(settings.getRetryFallbackSettings(), models);
}

export function isModelFallbackDisabled(flag: boolean | string | undefined, environment = process.env): boolean {
	return flag === true || environment.SENPI_NO_FALLBACK === "1";
}
