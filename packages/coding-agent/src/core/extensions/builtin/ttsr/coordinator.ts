import {
	COLLAPSE_REMEDIATION,
	CONTROL_LEAK_REMEDIATION,
	type DetectionResolution,
	type DetectorMatch,
	type GenerationDetectionState,
} from "./types.ts";

export function createGenerationState(): GenerationDetectionState {
	return { abortClaimed: false, userCancelled: false };
}

export function resolveDetection(
	directLeak: DetectorMatch | null,
	collapse: DetectorMatch | null,
	corroboratedLeak: DetectorMatch | null,
): DetectionResolution | null {
	const leak = directLeak ?? corroboratedLeak;
	if (leak) {
		return {
			owner: "control-token-leak",
			observedRules: collapse ? ["control-token-leak", "collapse-repetition"] : ["control-token-leak"],
			match: leak,
			remediation: CONTROL_LEAK_REMEDIATION,
		};
	}
	if (collapse) {
		return {
			owner: "collapse-repetition",
			observedRules: ["collapse-repetition"],
			match: collapse,
			remediation: COLLAPSE_REMEDIATION,
		};
	}
	return null;
}

export function claimAbort(state: GenerationDetectionState, resolution: DetectionResolution): boolean {
	if (state.abortClaimed || state.userCancelled) return false;
	state.abortClaimed = true;
	state.abortOwner = resolution.owner;
	state.selfAbortAt = Date.now();
	return true;
}

export function markUserCancelled(state: GenerationDetectionState): void {
	state.userCancelled = true;
}
