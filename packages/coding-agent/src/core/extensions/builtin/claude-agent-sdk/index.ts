import { getModels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "../types.ts";
import { streamClaudeAgentSdk } from "./stream.ts";

export const CLAUDE_AGENT_SDK_PROVIDER_ID = "claude-agent-sdk";

const MODELS = getModels("anthropic").map((model) => ({
	id: model.id,
	name: model.name,
	reasoning: model.reasoning,
	input: model.input,
	cost: model.cost,
	contextWindow: model.contextWindow,
	maxTokens: model.maxTokens,
	thinkingLevelMap: {
		...model.thinkingLevelMap,
		minimal: null,
	},
}));

export default function claudeAgentSdkExtension(pi: ExtensionAPI): void {
	pi.registerProvider(CLAUDE_AGENT_SDK_PROVIDER_ID, {
		baseUrl: CLAUDE_AGENT_SDK_PROVIDER_ID,
		api: CLAUDE_AGENT_SDK_PROVIDER_ID,
		apiKey: "claude-agent-sdk-managed",
		models: MODELS,
		streamSimple: streamClaudeAgentSdk,
	});
}
