import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "../../../compaction/index.ts";

function estimateMessageTokens(message: AgentMessage): number {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") {
		return estimateTokens({
			role: "assistant",
			content: content,
			api: "openai",
			provider: "openai",
			model: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
			stopReason: "end_turn",
			timestamp: 0,
		} as unknown as AgentMessage);
	}
	return 0;
}

export interface ComputeStructuralYieldOptions {
	previousSummary?: string;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	summary: string;
	tokensBefore: number;
}

export interface StructuralYield {
	savedTokens: number;
	savingsRatio: number;
	tokensBefore: number;
}

function approxTokens(text: string): number {
	return Math.max(0, estimateMessageTokens({ role: "assistant", content: text } as unknown as AgentMessage));
}

function sumEstimateTokens(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => {
		const content = (message as { content?: unknown }).content;
		if (typeof content !== "string") return total;
		return total + estimateMessageTokens(message);
	}, 0);
}

export function computeStructuralYield({
	previousSummary,
	messagesToSummarize,
	turnPrefixMessages,
	summary,
	tokensBefore,
}: ComputeStructuralYieldOptions): StructuralYield {
	const replacedTokens =
		approxTokens(previousSummary ?? "") +
		sumEstimateTokens(messagesToSummarize) +
		sumEstimateTokens(turnPrefixMessages);
	const savedTokens = Math.max(0, replacedTokens - approxTokens(summary));
	return {
		savedTokens,
		savingsRatio: tokensBefore > 0 ? savedTokens / tokensBefore : 0,
		tokensBefore,
	};
}

export function isIneffectiveCompaction({ tokensBefore, savedTokens, savingsRatio }: StructuralYield): boolean {
	return tokensBefore <= 0 || savedTokens < 1024 || savingsRatio < 0.1;
}
