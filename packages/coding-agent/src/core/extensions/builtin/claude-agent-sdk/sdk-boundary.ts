import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";

export type { Base64ImageSource, ContentBlockParam, Options, SDKMessage, SDKUserMessage };

export type SdkQueryInput = Parameters<typeof query>[0];
export type SdkQueryHandle = AsyncIterable<SDKMessage> & {
	interrupt(): Promise<unknown>;
	close(): void;
};
export type SdkQuery = (input: SdkQueryInput) => SdkQueryHandle;

export type SdkBoundary = {
	query: SdkQuery;
	createSdkMcpServer: typeof createSdkMcpServer;
};

const defaultSdkBoundary: SdkBoundary = { query, createSdkMcpServer };
let activeSdkBoundary = defaultSdkBoundary;

export function getSdkBoundary(): SdkBoundary {
	return activeSdkBoundary;
}

export function overrideSdkBoundary(override: Partial<SdkBoundary>): void {
	activeSdkBoundary = { ...defaultSdkBoundary, ...override };
}

export function resetSdkBoundary(): void {
	activeSdkBoundary = defaultSdkBoundary;
}

export default defaultSdkBoundary;
