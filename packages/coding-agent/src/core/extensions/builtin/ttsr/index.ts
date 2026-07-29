import { getKeybindings } from "@earendil-works/pi-tui";

import type { ExtensionAPI, ExtensionContext, MessageUpdateEvent } from "../../types.ts";
import { registerTtsrCommands, type TtsrPublicState } from "./commands.ts";
import { claimAbort, createGenerationState, markUserCancelled } from "./coordinator.ts";
import { discoverTtsrRulesSync } from "./discovery.ts";
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
	type GenerationDetectionState,
	type TtsrRule,
} from "./types.ts";
import { StreamWatcher } from "./watch.ts";

interface PendingRemediation {
	readonly resolution: DetectionResolution;
	readonly streamKind: "text" | "thinking";
}

interface PendingRuleNudge {
	readonly rule: TtsrRule;
}

const INTERRUPT_KEYBINDING = "app.interrupt";

function isInterruptKey(data: string): boolean {
	try {
		return getKeybindings().matches(data, INTERRUPT_KEYBINDING);
	} catch {
		return false;
	}
}

function parseDisabledRules(raw: boolean | string | undefined): string[] {
	return typeof raw === "string" && raw.length > 0
		? raw.split(",").map((name) => name.trim()).filter((name) => name.length > 0)
		: [];
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

	let manager: TtsrManager | null = null;
	let watcher: StreamWatcher | null = null;
	let genState: GenerationDetectionState = createGenerationState();
	let generation = 0;
	let pendingRemediation: PendingRemediation | null = null;
	let pendingRuleNudge: PendingRuleNudge | null = null;
	let pendingNudge: TtsrNudgeMessage | null = null;
	let disabled = false;

	function cancelRemediation(): void {
		if (pendingRemediation !== null || pendingNudge !== null || pendingRuleNudge !== null) {
			markUserCancelled(genState);
			pendingRemediation = null;
			pendingRuleNudge = null;
			pendingNudge = null;
		}
	}

	function recordInjection(owner: string, observed: readonly string[], retryMode: string): void {
		pi.appendEntry(TTSR_INJECTION_CUSTOM_TYPE, {
			rules: observed,
			owner,
			remediation: retryMode,
			at: Date.now(),
		});
	}

	function notify(ctx: ExtensionContext, owner: string): void {
		if (ctx.mode !== "tui") return;
		try {
			ctx.ui.notify(`Stream rule triggered: ${owner}`, "warning");
		} catch {
			return;
		}
	}

	function ensureInitialized(ctx: ExtensionContext): void {
		if (manager !== null) return;
		disabled = pi.getFlag("ttsr-disabled") === true;
		const disabledRules = parseDisabledRules(pi.getFlag("ttsr-rules-disabled"));
		const settings = { ...DEFAULT_TTSR_SETTINGS, enabled: !disabled, disabledRules };
		manager = new TtsrManager(settings, (pattern) => compileRuleCondition(pattern).regex);
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
		const discovered = discoverTtsrRulesSync(ctx.cwd);
		for (const rule of discovered.rules) {
			manager.addRule(rule);
		}
		watcher = new StreamWatcher(manager, disabledRules);
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

	function publicState(): TtsrPublicState {
		return {
			rules: manager?.getRules() ?? [],
			injectedRuleNames: manager?.getInjectedRuleNames() ?? [],
			disabled,
		};
	}

	registerTtsrCommands(pi, publicState);

	pi.on("session_start", (_event, ctx) => {
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
		pendingRemediation = null;
		pendingRuleNudge = null;
		watcher?.reset();
	});

	pi.on("turn_end", () => {
		manager?.incrementMessageCount();
	});

	pi.on("message_update", (event: MessageUpdateEvent, ctx) => {
		ensureInitialized(ctx);
		if (disabled || manager === null || watcher === null) return;
		const deltaEvent = event.assistantMessageEvent;
		if (deltaEvent.type !== "text_delta" && deltaEvent.type !== "thinking_delta") return;
		const source = deltaEvent.type === "text_delta" ? "text" : "thinking";
		const streamKey = `${source}:${String(deltaEvent.contentIndex)}`;
		const outcome = watcher.handleDelta(source, streamKey, deltaEvent.delta, generation);
		if (outcome.resolution !== null) console.log("TTSRDBG claim pre:", genState.abortClaimed, genState.userCancelled);
		if (outcome.resolution !== null && claimAbort(genState, outcome.resolution)) {
			pendingRemediation = { resolution: outcome.resolution, streamKind: source };
			notify(ctx, outcome.resolution.owner);
			console.log("TTSRDBG abort call");
			ctx.abort();
			return;
		}
		const interrupting = outcome.ruleMatches.filter((rule) => rule.interruptMode === "always");
		const rule = interrupting[0];
		if (rule !== undefined && pendingRuleNudge === null && !genState.abortClaimed) {
			genState.abortClaimed = true;
			genState.abortOwner = "collapse-repetition";
			genState.selfAbortAt = Date.now();
			pendingRuleNudge = { rule };
			notify(ctx, rule.name);
			ctx.abort();
		}
	});

	pi.on("message_end", (event) => {
		if (genState.userCancelled) return undefined;
		if (event.message.role !== "assistant") return undefined;
		if (pendingRuleNudge !== null) {
			const pending = pendingRuleNudge;
			pendingRuleNudge = null;
			manager?.markInjectedByNames([pending.rule.name]);
			recordInjection(pending.rule.name, [pending.rule.name], "nudge");
			pendingNudge = buildNudgeMessage(pending.rule.name, pending.rule.content);
			return undefined;
		}
		if (pendingRemediation === null) return undefined;
		const pending = pendingRemediation;
		pendingRemediation = null;
		try {
			if (pending.resolution.remediation.corruptionScope === "generation") {
				recordInjection(pending.resolution.owner, pending.resolution.observedRules, "provider-error");
				return { message: { ...event.message, ...buildErrorShellReplacement() } };
			}
			const replaced = buildTruncateReplacement(
				event.message as unknown as TruncatableAssistantMessage,
				pending.resolution.match.garbageStartOffset,
				pending.streamKind,
			);
			recordInjection(pending.resolution.owner, pending.resolution.observedRules, "nudge");
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
