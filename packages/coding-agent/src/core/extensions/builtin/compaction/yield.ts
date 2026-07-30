import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "../../../compaction/index.ts";

function estimateMessageTokens(message: AgentMessage): number {
	return estimateTokens(message);
}

export interface ComputeStructuralYieldOptions {
	previousSummary: string;
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
	return Math.max(
		0,
		estimateMessageTokens({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai",
			provider: "openai",
			model: "",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		}),
	);
}

function sumEstimateTokens(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
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
