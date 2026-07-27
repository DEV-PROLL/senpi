import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../../../../config.ts";
import type { ExtensionAPI } from "../../types.ts";
import { registerClaudeAccountCommand } from "./account-command.ts";
import { CLAUDE_AGENT_SDK_PROVIDER_ID } from "./account-management.ts";
import type { ClaudeAgentSdkCredential } from "./accounts.ts";
import { createOAuthConfig } from "./oauth-login.ts";
import { streamClaudeAgentSdk } from "./stream.ts";

export { CLAUDE_AGENT_SDK_PROVIDER_ID } from "./account-management.ts";

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

function readStoredCredential(providerId: string): ClaudeAgentSdkCredential | undefined {
	const authPath = join(getAgentDir(), "auth.json");
	if (!existsSync(authPath)) return undefined;
	try {
		const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, ClaudeAgentSdkCredential>;
		return data[providerId];
	} catch {
		return undefined;
	}
}

export default function claudeAgentSdkExtension(pi: ExtensionAPI): void {
	registerClaudeAccountCommand(pi);
	pi.registerProvider(CLAUDE_AGENT_SDK_PROVIDER_ID, {
		baseUrl: CLAUDE_AGENT_SDK_PROVIDER_ID,
		api: CLAUDE_AGENT_SDK_PROVIDER_ID,
		apiKey: "claude-agent-sdk-managed",
		models: MODELS,
		streamSimple: streamClaudeAgentSdk,
		oauth: createOAuthConfig({
			readCurrent: async () => readStoredCredential(CLAUDE_AGENT_SDK_PROVIDER_ID),
			readAnthropicCredential: async () => {
				const credential = readStoredCredential("anthropic");
				return credential && typeof credential.access === "string"
					? { access: credential.access, refresh: credential.refresh, expires: credential.expires }
					: undefined;
			},
		}),
	});
}
