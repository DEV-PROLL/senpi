import { getKeybindings } from "@earendil-works/pi-tui";

import type { ExtensionAPI, ExtensionContext, MessageUpdateEvent } from "../../types.ts";
import { claimAbort, createGenerationState, markUserCancelled, resolveDetection } from "./coordinator.ts";
import { collapseDetector, createCollapseState } from "./detectors/collapse.ts";
import { corroboratesControlLeak, createControlLeakDetector } from "./detectors/control-leak.ts";
import { TtsrManager } from "./manager.ts";
import { COLLAPSE_RULE_CONTENT } from "./prompts.ts";
import {
	buildErrorShellReplacement,
	buildNudgeMessage,
	buildTruncateReplacement,
	type TruncatableAssistantMessage,
	type TtsrNudgeMessage,
} from "./remediation.ts";
import { compileRuleCondition } from "./rule-condition.ts";
import {
	DEFAULT_TTSR_SETTINGS,
	TTSR_INJECTION_CUSTOM_TYPE,
	type DetectionResolution,
	type DetectorContext,
	type GenerationDetectionState,
} from "./types.ts";

interface StreamTrack {
	readonly collapse: ReturnType<typeof createCollapseState>;
	readonly leak: ReturnType<ReturnType<typeof createControlLeakDetector>["createState"]>;
}

interface PendingRemediation {
	readonly resolution: DetectionResolution;
	readonly streamKind: "text" | "thinking";
}

const INTERRUPT_KEYBINDING = "app.interrupt";

function isInterruptKey(data: string): boolean {
	try {
		return getKeybindings().matches(data, INTERRUPT_KEYBINDING);
	} catch {
		return false;
	}
}

export default function ttsrExtension(pi: ExtensionAPI): void {
	pi.registerFlag("ttsr-disabled", {
		type: "boolean",
		default: false,
		description: "Disable TTSR stream-rule detection.",
	});
	pi.registerFlag("ttsr-rules-disabled", {
		type: "string",
		default: "",
		description: "Comma-separated TTSR rule names to disable.",
	});

	const leakDetector = createControlLeakDetector();
	let manager: TtsrManager | null = null;
	let initialized = false;
	let genState: GenerationDetectionState = createGenerationState();
	let generation = 0;
	let pendingRemediation: PendingRemediation | null = null;
	let pendingNudge: TtsrNudgeMessage | null = null;
	let disabled = false;

	const tracks = new Map<string, StreamTrack>();

	function trackFor(source: "text" | "thinking", streamKey: string): StreamTrack {
		const key = `${source}:${streamKey}`;
		let track = tracks.get(key);
		if (track === undefined) {
			track = { collapse: createCollapseState(), leak: leakDetector.createState() };
			tracks.set(key, track);
		}
		return track;
	}

	function cancelRemediation(): void {
		if (pendingRemediation !== null || pendingNudge !== null) {
			markUserCancelled(genState);
			pendingRemediation = null;
			pendingNudge = null;
		}
	}

	function recordInjection(resolution: DetectionResolution): void {
		pi.appendEntry(TTSR_INJECTION_CUSTOM_TYPE, {
			rules: resolution.observedRules,
			owner: resolution.owner,
			remediation: resolution.remediation.retryMode,
			at: Date.now(),
		});
	}

	function notify(ctx: ExtensionContext, resolution: DetectionResolution): void {
		if (ctx.mode !== "tui") return;
		try {
			ctx.ui.notify(`Stream rule triggered: ${resolution.owner}`, "warning");
		} catch {
			return;
		}
	}

	function resolveForDelta(
		track: StreamTrack,
		delta: string,
		detectorCtx: DetectorContext,
	): DetectionResolution | null {
		const leakMatch = leakDetector.checkDelta(track.leak, delta, detectorCtx);
		const collapseMatch = collapseDetector.checkDelta(track.collapse, delta, detectorCtx);
		const evidence = track.leak.pendingEvidence;
		const corroborated =
			collapseMatch !== null &&
			evidence !== undefined &&
			corroboratesControlLeak(evidence, collapseMatch.anomalyStartOffset, track.leak.currentOffset)
				? collapseMatch
				: null;
		return resolveDetection(leakMatch, collapseMatch, corroborated);
	}

	function ensureInitialized(ctx: ExtensionContext): void {
		if (initialized) return;
		initialized = true;
		disabled = pi.getFlag("ttsr-disabled") === true;
		const disabledRulesRaw = pi.getFlag("ttsr-rules-disabled");
		const disabledRules = typeof disabledRulesRaw === "string" && disabledRulesRaw.length > 0
			? disabledRulesRaw.split(",").map((name) => name.trim()).filter((name) => name.length > 0)
			: [];
		manager = new TtsrManager({ ...DEFAULT_TTSR_SETTINGS, enabled: !disabled, disabledRules }, (pattern) => compileRuleCondition(pattern).regex);
		const injectedNames = ctx.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === TTSR_INJECTION_CUSTOM_TYPE)
			.flatMap((entry) => {
				const data = entry.type === "custom" ? entry.data : undefined;
				if (typeof data !== "object" || data === null || !("rules" in data)) return [];
				const rules = (data as { rules?: unknown }).rules;
				return Array.isArray(rules) ? rules.filter((rule): rule is string => typeof rule === "string") : [];
			});
		manager.restoreInjected(injectedNames);
		if (ctx.mode === "tui") {
			try {
				ctx.ui.onTerminalInput((data) => {
					if (isInterruptKey(data)) cancelRemediation();
				});
			} catch {
				return;
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		ensureInitialized(ctx);
	});

	pi.on("session_abort", () => {
		cancelRemediation();
	});

	pi.on("input", () => {
		cancelRemediation();
	});

	pi.on("turn_start", (_event, ctx) => {
		ensureInitialized(ctx);
		generation += 1;
		genState = createGenerationState();
		tracks.clear();
		pendingRemediation = null;
		manager?.resetBuffers();
	});

	pi.on("turn_end", () => {
		manager?.incrementMessageCount();
	});

	pi.on("message_update", (event: MessageUpdateEvent, ctx) => {
		ensureInitialized(ctx);
		if (disabled || manager === null) return;
		const deltaEvent = event.assistantMessageEvent;
		if (deltaEvent.type !== "text_delta" && deltaEvent.type !== "thinking_delta") return;
		const source = deltaEvent.type === "text_delta" ? "text" : "thinking";
		const streamKey = `${source}:${String(deltaEvent.contentIndex)}`;
		const detectorCtx: DetectorContext = { source, streamKey, generation };
		const track = trackFor(source, streamKey);
		const resolution = resolveForDelta(track, deltaEvent.delta, detectorCtx);
		if (resolution !== null && claimAbort(genState, resolution)) {
			pendingRemediation = { resolution, streamKind: source };
			notify(ctx, resolution);
			ctx.abort();
		}
	});

	pi.on("message_end", (event) => {
		if (pendingRemediation === null || genState.userCancelled) return undefined;
		if (event.message.role !== "assistant") return undefined;
		const pending = pendingRemediation;
		pendingRemediation = null;
		try {
			if (pending.resolution.remediation.corruptionScope === "generation") {
				recordInjection(pending.resolution);
				return { message: { ...event.message, ...buildErrorShellReplacement() } };
			}
			const replaced = buildTruncateReplacement(
				event.message as unknown as TruncatableAssistantMessage,
				pending.resolution.match.garbageStartOffset,
				pending.streamKind,
			);
			recordInjection(pending.resolution);
			pendingNudge = buildNudgeMessage(pending.resolution.owner, COLLAPSE_RULE_CONTENT);
			return { message: replaced as unknown as typeof event.message };
		} catch (error) {
			pi.appendEntry("ttsr-remediation-error", {
				message: error instanceof Error ? error.message : String(error),
				at: Date.now(),
			});
			return undefined;
		}
	});

	pi.on("agent_settled", () => {
		if (pendingNudge === null || genState.userCancelled) {
			pendingNudge = null;
			return;
		}
		const nudge = pendingNudge;
		pendingNudge = null;
		pi.sendMessage(nudge, { triggerTurn: true });
	});

}
