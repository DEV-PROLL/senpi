import type { AuthInteraction, OAuthAuth, OAuthCredentials } from "@earendil-works/pi-ai";
import { loadAnthropicOAuth } from "@earendil-works/pi-ai/oauth";
import {
	addAccount,
	emptyCredential,
	SENTINEL_OAUTH_FIELDS,
	listAccounts,
	type AccountSlot,
	type ClaudeAgentSdkCredential,
} from "./accounts.ts";

export type OAuthLoginCallbacks = {
	signal?: AbortSignal;
	onAuth?: (event: { url: string }) => void | Promise<void>;
	onPrompt?: (prompt: { message: string; placeholder?: string }) => Promise<string>;
	onManualCodeInput?: () => Promise<string>;
	onProgress?: (message: string) => void;
};

export type CurrentCredentialReader = () => Promise<ClaudeAgentSdkCredential | undefined>;

export type OAuthConfigShape = {
	name: string;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
};

export const CLAUDE_AGENT_SDK_OAUTH_NAME = "Claude Agent SDK (Claude Pro/Max)";

function toSlot(credential: { access: string; refresh: string; expires: number }, name: string, source: AccountSlot["source"]): AccountSlot {
	return { name, access: credential.access, refresh: credential.refresh, expires: credential.expires, source };
}

async function promptAccountName(
	callbacks: OAuthLoginCallbacks,
	existing: AccountSlot[],
): Promise<string> {
	if (existing.length === 0) return "default";
	if (!callbacks.onPrompt) return `account-${existing.length + 1}`;
	const answer = (
		await callbacks.onPrompt({
			message: `Name for this account (existing: ${existing.map((slot) => slot.name).join(", ")})`,
			placeholder: `account-${existing.length + 1}`,
		})
	).trim();
	return answer || `account-${existing.length + 1}`;
}

export function createOAuthConfig(deps: {
	readCurrent: CurrentCredentialReader;
	readAnthropicCredential?: () => Promise<{ access: string; refresh: string; expires: number } | undefined>;
	loginFlow?: OAuthAuth;
}): OAuthConfigShape {
	return {
		name: CLAUDE_AGENT_SDK_OAUTH_NAME,

		async login(callbacks) {
			const current = (await deps.readCurrent()) ?? emptyCredential();
			const interaction: AuthInteraction = {
				signal: callbacks.signal,
				prompt: async (prompt) => {
					if (prompt.type === "select") return "";
					return callbacks.onPrompt ? callbacks.onPrompt({ message: prompt.message }) : "";
				},
				notify: (event) => {
					if (event.type === "auth_url" && callbacks.onAuth) void callbacks.onAuth({ url: event.url });
					if (event.type === "progress" && callbacks.onProgress) callbacks.onProgress(event.message);
				},
			};
			const flow = deps.loginFlow ?? (await loadAnthropicOAuth());
			const credential = await flow.login(interaction);

			const existing = listAccounts(current);
			const name = await promptAccountName(callbacks, existing);
			let next = addAccount(current, toSlot(credential, name, "login"));

			if (existing.length === 0 && deps.readAnthropicCredential) {
				const imported = await deps.readAnthropicCredential();
				if (imported) {
					next = addAccount(next, toSlot(imported, "imported-anthropic", "import"));
				}
			}
			return next;
		},

		async refreshToken(credentials) {
			return credentials;
		},

		getApiKey(credentials) {
			return SENTINEL_OAUTH_FIELDS.access;
		},
	};
}
