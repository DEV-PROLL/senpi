import { readFileSync } from "node:fs";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import { overrideSystemPromptGuidance, systemPromptBoundaryGuidance } from "./guidance.ts";
import type { ClaudeSdkOauthSystemPromptMode } from "./settings.ts";

const DYNAMIC_TAIL_MARKER = "\nCurrent date: ";

type CustomSystemPrompt = string | string[];

export function splitSystemPromptAtDynamicTail(
	prompt: string | undefined,
	mode: ClaudeSdkOauthSystemPromptMode,
): CustomSystemPrompt {
	const content = prompt ?? "";
	const markerIndex = content.lastIndexOf(DYNAMIC_TAIL_MARKER);
	if (markerIndex === -1) {
		console.warn(systemPromptBoundaryGuidance(mode));
		return content;
	}
	return [content.slice(0, markerIndex), SYSTEM_PROMPT_DYNAMIC_BOUNDARY, content.slice(markerIndex + 1)];
}

export function loadOverrideSystemPrompt(path: string | undefined): CustomSystemPrompt {
	if (path === undefined) {
		throw new Error(overrideSystemPromptGuidance(undefined, "the path is not configured"));
	}
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch (error: unknown) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(overrideSystemPromptGuidance(path, reason));
	}
	if (content.trim().length === 0) {
		throw new Error(overrideSystemPromptGuidance(path, "the file is empty"));
	}
	return splitSystemPromptAtDynamicTail(content, "override");
}
