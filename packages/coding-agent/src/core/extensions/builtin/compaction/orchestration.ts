import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type CompactionPreparation, estimateTokens } from "../../../compaction/index.ts";
import type { BeforeAgentStartEventResult } from "../../types.ts";
import { type IdleCompactionDecision, shouldWarmAtIdle } from "./idle.ts";
import * as policy from "./policy.ts";
import { isWarmResultStale, isWithinGraceBand, resolveSpeculationLeadTokens } from "./speculation-lead.ts";
import {
	admitToolResult,
	estimateAdmissionMarkerTokens,
	resolveToolResultAdmissionCapTokens,
} from "./tool-admission.ts";

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
): { text: string; admitted: boolean; spillPath?: string } {
	const result = admitToolResult({ text, contextWindow, spillDir, capTokens });
	return { text: result.text, admitted: result.spilled, spillPath: result.spillPath };
}

export function admitContextToolResults(
	messages: AgentMessage[],
	contextWindow: number,
	enabled: boolean,
	capOverride?: number,
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
		const textParts = message.content.filter((part) => part.type === "text" && part.text);
		const hasSharedOmission = textParts.length >= 2;
		const resultCap = capOverride ?? resolveToolResultAdmissionCapTokens(contextWindow);
		let remainingTokens = resultCap;
		const omitted: Array<{ tokens: number; path: string }> = [];
		const content = message.content.map((part) => {
			if (part.type !== "text" || !part.text) return part;
			const partTokens = estimateTextTokens(part.text);
			const omissionReserve = hasSharedOmission
				? 256 + estimateAdmissionMarkerTokens(partTokens, join(spillDir, "tool-result-0000000000-000000.txt"))
				: 0;
			if (partTokens <= remainingTokens - omissionReserve) {
				remainingTokens -= partTokens;
				return part;
			}
			const admitted = admitContextToolResult(
				part.text,
				contextWindow,
				spillDir,
				Math.max(0, remainingTokens - omissionReserve),
			);
			changed = true;
			remainingTokens = Math.max(0, remainingTokens - estimateTextTokens(admitted.text));
			if (admitted.spillPath) omitted.push({ tokens: partTokens, path: admitted.spillPath });
			return { ...part, text: admitted.text };
		});
		if (omitted.length > 0) {
			const omission = `[tool-result admission: ${omitted.length} later text part(s) omitted (~${omitted.reduce((sum, item) => sum + item.tokens, 0)} tokens); full outputs at: ${omitted.map((item) => item.path).join("; ")} - read with the read tool]`;
			const lastText = content.findLastIndex((part) => part.type === "text" && part.text);
			const target = lastText >= 0 ? lastText : content.findIndex((part) => part.type === "text");
			const targetPart = target >= 0 ? content[target] : undefined;
			if (target >= 0 && targetPart?.type === "text") {
				content[target] = { ...targetPart, text: `${targetPart.text ?? ""}\n${omission}` };
			}
		}
		// Contract: total retained text tokens per tool result <= cap, and every omitted byte is reachable via a spill path named within the result.
		const aggregateTokens = () =>
			estimateTextTokens(
				content
					.filter((part) => part.type === "text")
					.map((part) => part.text ?? "")
					.join("\n"),
			);
		while (aggregateTokens() > resultCap) {
			const target = content.findLastIndex((part) => part.type === "text" && part.text);
			if (target < 0) break;
			const part = content[target];
			if (part.type !== "text") break;
			const text = part.text ?? "";
			const omissionIndex = text.indexOf("[tool-result admission:");
			if (omissionIndex === 1 || omissionIndex === 0) break;
			const prefix = omissionIndex >= 0 ? text.slice(0, omissionIndex) : text;
			const suffix = omissionIndex >= 0 ? text.slice(omissionIndex) : "";
			const nextText = `${prefix.slice(0, Math.floor(prefix.length / 2))}${suffix}`;
			content[target] = { ...part, text: nextText === text ? "" : nextText };
		}
		return changed ? { ...message, content } : message;
	});
}
