import type {
	AuthCheck,
	AuthContext,
	AuthInteraction,
	OAuthAuth,
	OAuthCredential,
	OAuthCredentials,
} from "@earendil-works/pi-ai";
import { loadAnthropicOAuth } from "@earendil-works/pi-ai/oauth";
import {
	type AccountSlot,
	addAccount,
	type ClaudeSdkOauthCredential,
	emptyCredential,
	listAccounts,
	SENTINEL_OAUTH_FIELDS,
} from "./accounts.ts";
import { readAmbientClaudeAuthStatus } from "./availability.ts";

export type OAuthLoginCallbacks = {
	signal?: AbortSignal;
	onAuth?: (event: { url: string }) => void | Promise<void>;
	onPrompt?: (prompt: { message: string; placeholder?: string }) => Promise<string>;
	onManualCodeInput?: () => Promise<string>;
	onProgress?: (message: string) => void;
};

export type CurrentCredentialReader = () => Promise<ClaudeSdkOauthCredential | undefined>;

export type OAuthConfigShape = {
	name: string;
	check(input: { ctx: AuthContext; credential?: OAuthCredential }): Promise<AuthCheck | undefined>;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
};

export const CLAUDE_SDK_OAUTH_NAME = "Claude SDK OAuth (Claude Pro/Max)";
const ENV_TOKEN_NAMES = [
	"CLAUDE_CODE_OAUTH_TOKEN",
	...Array.from({ length: 15 }, (_, index) => `CLAUDE_CODE_OAUTH_TOKEN_${index + 2}`),
] as const;
const AUTH_CHECK = { source: "Claude SDK OAuth", type: "oauth" } as const;

function toSlot(
	credential: { access: string; refresh: string; expires: number },
	name: string,
	source: AccountSlot["source"],
): AccountSlot {
	return { name, access: credential.access, refresh: credential.refresh, expires: credential.expires, source };
}

async function promptAccountName(callbacks: OAuthLoginCallbacks, existing: AccountSlot[]): Promise<string> {
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
	readAmbientAuthStatus?: () => Promise<boolean>;
	loginFlow?: OAuthAuth;
}): OAuthConfigShape {
	return {
		name: CLAUDE_SDK_OAUTH_NAME,

		async check({ ctx, credential }) {
			const stored = credential as ClaudeSdkOauthCredential | undefined;
			if (stored?.type === "oauth" && Array.isArray(stored.accounts) && stored.accounts.length > 0) {
				return AUTH_CHECK;
			}
			const envTokens = await Promise.all(ENV_TOKEN_NAMES.map((name) => ctx.env(name)));
			if (envTokens.some((token) => token !== undefined && token.length > 0)) return AUTH_CHECK;
			return (await (deps.readAmbientAuthStatus ?? readAmbientClaudeAuthStatus)()) ? AUTH_CHECK : undefined;
		},

		async login(callbacks) {
			const current = (await deps.readCurrent()) ?? emptyCredential();
			const existing = listAccounts(current);
			if (existing.length === 0 && deps.readAnthropicCredential && callbacks.onPrompt) {
				const imported = await deps.readAnthropicCredential();
				if (imported) {
					const answer = (
						await callbacks.onPrompt({
							message: "An Anthropic OAuth login already exists. Import it instead of a new login? [y/N]",
						})
					)
						.trim()
						.toLowerCase();
					if (answer === "y" || answer === "yes") {
						return addAccount(current, toSlot(imported, "imported-anthropic", "import"));
					}
				}
			}
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

			const existingAfter = listAccounts(current);
			const name = await promptAccountName(callbacks, existingAfter);
			return addAccount(current, toSlot(credential, name, "login"));
		},

		async refreshToken(credentials) {
			return credentials;
		},

		getApiKey(_credentials) {
			return SENTINEL_OAUTH_FIELDS.access;
		},
	};
}
