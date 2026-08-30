import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type CompactionPreparation, estimateTokens } from "../../../compaction/index.ts";
import type { BeforeAgentStartEventResult } from "../../types.ts";
import { type IdleCompactionDecision, shouldWarmAtIdle } from "./idle.ts";
import * as policy from "./policy.ts";
import { isWarmResultStale, isWithinGraceBand, resolveSpeculationLeadTokens } from "./speculation-lead.ts";
import { admitToolResult, resolveToolResultAdmissionCapTokens } from "./tool-admission.ts";

export interface CompactionGeometry {
	reserveTokens: number;
	thresholdTokens: number;
	leadTokens: number;
}

export function estimateTextTokens(text: string): number {
	return estimateTokens({ role: "user", content: text, timestamp: 0 });
}

export function resolveCompactionGeometry(input: {
	contextWindow: number;
	settings: CompactionPreparation["settings"];
	lastYield?: { savedTokens: number; tokensBefore: number };
}): CompactionGeometry {
	const thresholdTokens = input.contextWindow * policy.computeEffectiveThreshold(input.contextWindow, input.lastYield);
	return {
		reserveTokens: policy.resolveEffectiveReserveTokens(
			input.contextWindow,
			input.settings.reserveTokens,
			input.settings.reserveScalingEnabled !== false,
		),
		thresholdTokens,
		leadTokens: resolveSpeculationLeadTokens(thresholdTokens, input.settings.speculativeLeadTokens),
	};
}

export function shouldDeferGraceBand(input: {
	tokens: number;
	thresholdTokens: number;
	leadTokens: number;
	contextWindow: number;
	reserveTokens: number;
	compactionInFlight: boolean;
	graceBandEnabled?: boolean;
}): boolean {
	return (
		input.compactionInFlight &&
		input.graceBandEnabled !== false &&
		isWithinGraceBand(input.tokens, input.thresholdTokens, input.leadTokens, input.contextWindow, input.reserveTokens)
	);
}

export function resolveBeforeAgentStartMessage(input: {
	message?: BeforeAgentStartEventResult["message"];
	reminder?: string;
	reminderEnabled?: boolean;
}): BeforeAgentStartEventResult["message"] | undefined {
	if (!input.reminder || input.reminderEnabled === false) return input.message;
	if (!input.message) return undefined;
	return { ...input.message, content: `${input.message.content}\n\n${input.reminder}` };
}

export function resolveReminderSystemPrompt(input: {
	systemPrompt: string;
	reminder?: string;
	reminderEnabled?: boolean;
}): string | undefined {
	if (!input.reminder || input.reminderEnabled === false) return undefined;
	return `${input.systemPrompt}\n\n${input.reminder}`;
}

export function resolveIdleWarmAction(
	decision: IdleCompactionDecision,
	job: { armedAtTokens: number } | undefined,
): "none" | "start" | "replace" {
	if (!shouldWarmAtIdle(decision)) return "none";
	if (!job) return "start";
	const currentTokens = decision.usage?.tokens ?? 0;
	return isWarmResultStale(job.armedAtTokens, currentTokens, decision.settings.keepRecentTokens) ? "replace" : "none";
}

export function admitContextToolResult(
	text: string,
	contextWindow: number,
	spillDir: string,
	capTokens?: number,
): { text: string; admitted: boolean } {
	const result = admitToolResult({ text, contextWindow, spillDir, capTokens });
	return { text: result.text, admitted: result.spilled };
}

export function admitContextToolResults(
	messages: AgentMessage[],
	contextWindow: number,
	enabled: boolean,
): AgentMessage[] {
	if (!enabled) return messages;
	return messages.map((message) => {
		if (message.role !== "toolResult") return message;
		const spillDir = join(tmpdir(), "senpi-tool-spill");
		if (typeof message.content === "string") {
			const admitted = admitContextToolResult(message.content, contextWindow, spillDir);
			return admitted.admitted ? { ...message, content: [{ type: "text" as const, text: admitted.text }] } : message;
		}
		let changed = false;
		let remainingTokens = resolveToolResultAdmissionCapTokens(contextWindow);
		const content = message.content.map((part) => {
			if (part.type !== "text" || !part.text) return part;
			const partTokens = estimateTextTokens(part.text);
			if (partTokens <= remainingTokens) {
				remainingTokens -= partTokens;
				return part;
			}
			if (remainingTokens <= 0) {
				changed = true;
				return { ...part, text: "" };
			}
			const admitted = admitContextToolResult(part.text, contextWindow, spillDir, remainingTokens);
			changed = true;
			remainingTokens = 0;
			return { ...part, text: admitted.text };
		});
		return changed ? { ...message, content } : message;
	});
}
