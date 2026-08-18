import type {
	EffortLevel,
	Options,
	SDKMessage,
	SDKUserMessage,
	SessionMessage,
	SettingSource,
	ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, getSessionMessages, query } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";

export type {
	Base64ImageSource,
	ContentBlockParam,
	EffortLevel,
	Options,
	SDKMessage,
	SDKUserMessage,
	SessionMessage,
	SettingSource,
	ThinkingConfig,
};

export type SdkQueryInput = Parameters<typeof query>[0];
export type SdkQueryHandle = AsyncIterable<SDKMessage> & {
	interrupt(): Promise<unknown>;
	setModel?: (model?: string) => Promise<void>;
	close(): void;
	initializationResult?: () => Promise<unknown>;
};
export type SdkQuery = (input: SdkQueryInput) => SdkQueryHandle;

export type SdkBoundary = {
	query: SdkQuery;
	createSdkMcpServer: typeof createSdkMcpServer;
	getSessionMessages: typeof getSessionMessages;
};

const defaultSdkBoundary: SdkBoundary = { query, createSdkMcpServer, getSessionMessages };
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
