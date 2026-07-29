import { estimateTokens } from "../../../compaction/index.ts";

export interface ComputeStructuralYieldOptions {
	previousSummary?: string;
	messagesToSummarize: Array<{ content?: unknown }>;
	turnPrefixMessages: Array<{ content?: unknown }>;
	summary: string;
	tokensBefore: number;
}

export interface StructuralYield {
	savedTokens: number;
	savingsRatio: number;
}

function approxTokens(text: string): number {
	return Math.max(0, estimateTokens({ role: "assistant", content: text, display: false, timestamp: 0 }));
}

function sumEstimateTokens(messages: Array<{ content?: unknown }>): number {
	return messages.reduce((total, message) => {
		if (typeof message.content !== "string") return total;
		return total + estimateTokens({ role: "assistant", content: message.content, display: false, timestamp: 0 });
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
	};
}

export function isIneffectiveCompaction({ tokensBefore, savedTokens, savingsRatio }: StructuralYield): boolean {
	return tokensBefore <= 0 || savedTokens < 1024 || savingsRatio < 0.1;
}
