import type { Credential } from "@earendil-works/pi-ai";
import type { AuthStorage } from "../../../auth-storage.ts";
import { emitProviderAccountsChanged } from "./account-events.ts";
import {
	type AccountSlot,
	type ClaudeAgentSdkCredential,
	emptyCredential,
	listAccounts,
	pinAccount,
	removeAccount,
} from "./accounts.ts";

export const CLAUDE_AGENT_SDK_PROVIDER_ID = "claude-agent-sdk";

export type ProviderAccountSummary = {
	readonly name: string;
	readonly source: AccountSlot["source"];
	readonly blocked: boolean;
	readonly pinned: boolean;
};

export function getProviderAccounts(
	storage: AuthStorage,
	provider: string,
	env: NodeJS.ProcessEnv = process.env,
): ProviderAccountSummary[] {
	assertManagedProvider(provider);
	const credential = credentialFrom(storage.get(provider));
	const now = Date.now();
	return listAccounts(credential, (name) => env[name]).map((account) => ({
		name: account.name,
		source: account.source,
		blocked:
			account.blockReason === "auth_error" || (account.blockedUntil !== undefined && account.blockedUntil > now),
		pinned: credential.pinned === account.name,
	}));
}

export async function pinProviderAccount(
	storage: AuthStorage,
	provider: string,
	name: string | null,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	assertManagedProvider(provider);
	await storage.modify(provider, async (current) => {
		const credential = credentialFrom(current);
		if (name === null) {
			if (credential.pinned === undefined) return current;
			const { pinned: _pinned, ...unpinned } = credential;
			return unpinned;
		}
		if (!listAccounts(credential, (key) => env[key]).some((account) => account.name === name)) {
			throw new Error(`Provider account not found: ${name}`);
		}
		return pinAccount(credential, name);
	});
	emitProviderAccountsChanged(provider);
}

export async function removeProviderAccount(storage: AuthStorage, provider: string, name: string): Promise<void> {
	assertManagedProvider(provider);
	await storage.modify(provider, async (current) => {
		const credential = credentialFrom(current);
		const account = (credential.accounts ?? []).find((candidate) => candidate.name === name);
		if (!account) {
			const environmentAccount = listAccounts(credential, (key) => process.env[key]).find(
				(candidate) => candidate.name === name,
			);
			if (environmentAccount?.source === "env") {
				throw new Error(`Environment provider account cannot be removed: ${name}`);
			}
			throw new Error(`Provider account not found: ${name}`);
		}
		return removeAccount(credential, name);
	});
	emitProviderAccountsChanged(provider);
}

function assertManagedProvider(provider: string): void {
	if (provider !== CLAUDE_AGENT_SDK_PROVIDER_ID) {
		throw new Error(`Provider account management is unavailable for: ${provider}`);
	}
}

function credentialFrom(credential: Credential | undefined): ClaudeAgentSdkCredential {
	if (credential === undefined) return emptyCredential();
	if (credential.type !== "oauth") throw new Error("Provider account management requires an OAuth credential");
	return credential as ClaudeAgentSdkCredential;
}
