import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { loadAnthropicOAuth } from "@earendil-works/pi-ai/oauth";
import { getAgentDir } from "../../../../config.ts";
import { AuthStorage } from "../../../auth-storage.ts";
import { emitProviderAccountFailover, emitProviderAccountsChanged } from "./account-events.ts";
import { CLAUDE_AGENT_SDK_PROVIDER_ID } from "./account-management.ts";
import {
	type AccountSlot,
	assertValidAccountName,
	type ClaudeAgentSdkCredential,
	emptyCredential,
	envSlotToken,
	listAccounts,
	refreshSlot,
	type SlotRefresher,
} from "./accounts.ts";
import { selectAccount } from "./affinity.ts";
import { classifySdkError } from "./errors.ts";
import { runFailover } from "./failover.ts";
import type { Options, SDKMessage, SdkQuery } from "./sdk-boundary.ts";
import type { ClaudeAgentSdkProviderSettings, ClaudeAgentSdkTokenInjection } from "./settings.ts";

export { CLAUDE_AGENT_SDK_PROVIDER_ID } from "./account-management.ts";

const EXPIRING_WITHIN_MS = 5 * 60_000;
const CLI_OAUTH_SCOPES = [
	"org:create_api_key",
	"user:profile",
	"user:inference",
	"user:sessions:claude_code",
	"user:mcp_servers",
	"user:file_upload",
] as const;

type AuthLaneBoundary = {
	createStore: () => CredentialStore;
	env: () => NodeJS.ProcessEnv;
	getAgentDir: () => string;
	now: () => number;
	refresher: SlotRefresher;
};

async function refreshWithAnthropicOAuth(refresh: string) {
	const oauth = await loadAnthropicOAuth();
	const credential = await oauth.refresh({ type: "oauth", access: "", refresh, expires: 0 });
	return { access: credential.access, refresh: credential.refresh, expires: credential.expires };
}

const defaultBoundary: AuthLaneBoundary = {
	createStore: () => AuthStorage.create(),
	env: () => process.env,
	getAgentDir,
	now: () => Date.now(),
	refresher: refreshWithAnthropicOAuth,
};
let activeBoundary = defaultBoundary;

export function overrideAuthLaneBoundary(override: Partial<AuthLaneBoundary>): void {
	activeBoundary = { ...activeBoundary, ...override };
}

export function resetAuthLaneBoundary(): void {
	activeBoundary = defaultBoundary;
}

export type AuthenticatedQueryInput = {
	prompt: Parameters<SdkQuery>[0]["prompt"];
	query: SdkQuery;
	buildOptions: (lane: ClaudeAgentSdkTokenInjection) => Options;
	providerSettings: ClaudeAgentSdkProviderSettings;
	sessionId?: string;
	/** Request-scoped CLI pin; takes precedence over persistent settings and account pins. */
	pinnedAccount?: string;
	onQuery?: (query: ReturnType<SdkQuery>) => void;
};

type ManagedPool = {
	accounts: AccountSlot[];
	lane: Exclude<ClaudeAgentSdkTokenInjection, "ambient">;
	pinnedAccount?: string;
	store: CredentialStore;
};

function managedEnvironment(parent: NodeJS.ProcessEnv): Record<string, string | undefined> {
	const {
		ANTHROPIC_API_KEY: _apiKey,
		ANTHROPIC_AUTH_TOKEN: _authToken,
		ANTHROPIC_BASE_URL: _gateway,
		ANTHROPIC_CUSTOM_HEADERS: _customHeaders,
		CLAUDE_CODE_OAUTH_TOKEN: _oauthToken,
		CLAUDE_CODE_USE_BEDROCK: _bedrock,
		CLAUDE_CODE_USE_FOUNDRY: _foundry,
		CLAUDE_CODE_USE_GATEWAY: _gatewayMode,
		CLAUDE_CODE_USE_VERTEX: _vertex,
		...environment
	} = parent;
	for (const name of Object.keys(environment)) {
		if (/^CLAUDE_CODE_OAUTH_TOKEN_\d+$/.test(name)) delete environment[name];
	}
	return environment;
}

function configDirectory(slot: AccountSlot): string {
	assertValidAccountName(slot.name);
	return join(activeBoundary.getAgentDir(), "claude-agent-sdk-accounts", slot.name);
}

function writeConfigCredentials(directory: string, slot: AccountSlot, access: string): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	writeFileSync(
		join(directory, ".credentials.json"),
		JSON.stringify({
			claudeAiOauth: {
				accessToken: access,
				refreshToken: slot.refresh,
				expiresAt: slot.expires,
				scopes: CLI_OAUTH_SCOPES,
			},
		}),
		{ encoding: "utf8", mode: 0o600 },
	);
}

async function managedPool(settings: ClaudeAgentSdkProviderSettings): Promise<ManagedPool | undefined> {
	const lane = settings.tokenInjection ?? "ambient";
	if (lane === "ambient") return undefined;
	const store = activeBoundary.createStore();
	let credential = await store.read(CLAUDE_AGENT_SDK_PROVIDER_ID);
	const environment = activeBoundary.env();
	let accounts = listAccounts(
		(credential as ClaudeAgentSdkCredential | undefined) ?? emptyCredential(),
		(name) => environment[name],
	);
	if (!credential && accounts.length > 0) {
		credential = await store.modify(CLAUDE_AGENT_SDK_PROVIDER_ID, async () => emptyCredential());
		accounts = listAccounts(
			(credential as ClaudeAgentSdkCredential) ?? emptyCredential(),
			(name) => environment[name],
		);
	}
	if (accounts.length === 0) return undefined;
	const stored = credential?.type === "oauth" ? (credential as ClaudeAgentSdkCredential) : undefined;
	return { accounts, lane, pinnedAccount: settings.pinnedAccount ?? stored?.pinned, store };
}

async function prepareSlot(pool: ManagedPool, selected: AccountSlot): Promise<Record<string, string | undefined>> {
	const environment = activeBoundary.env();
	const slot = selected;
	if (slot.source !== "env" && activeBoundary.now() >= slot.expires - EXPIRING_WITHIN_MS) {
		try {
			const refreshed = await refreshSlot(
				pool.store,
				CLAUDE_AGENT_SDK_PROVIDER_ID,
				slot.name,
				activeBoundary.refresher,
				(expires) => activeBoundary.now() >= expires - EXPIRING_WITHIN_MS,
			);
			const credential = refreshed?.type === "oauth" ? (refreshed as ClaudeAgentSdkCredential) : undefined;
			const updated = listAccounts(credential ?? emptyCredential(), (name) => environment[name]).find(
				(candidate) => candidate.name === slot.name,
			);
			if (!updated) throw new Error("selected account disappeared during refresh");
			Object.assign(slot, updated);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`authentication_failed: ${detail}`);
		}
	}
	const access = slot.source === "env" ? envSlotToken((name) => environment[name], slot.name) : slot.access;
	if (!access) throw new Error("authentication_failed: selected OAuth token is unavailable");
	const childEnvironment = managedEnvironment(environment);
	if (pool.lane === "oauth-slots") return { ...childEnvironment, CLAUDE_CODE_OAUTH_TOKEN: access };
	const directory = configDirectory(slot);
	writeConfigCredentials(directory, slot, access);
	return { ...childEnvironment, CLAUDE_CONFIG_DIR: directory };
}

function sdkFailure(message: SDKMessage): unknown | undefined {
	if (message.type === "assistant" && message.error) return message.error;
	if (message.type === "result" && message.subtype !== "success") {
		const errors = "errors" in message && Array.isArray(message.errors) ? (message.errors as unknown[]) : [];
		return new Error(errors.length > 0 ? String(errors[0]) : `Claude Code ${message.subtype}`);
	}
	return undefined;
}

function visibleSdkMessage(message: SDKMessage): boolean {
	if (message.type !== "stream_event") return false;
	return /^(?:content_block_start|content_block_delta|content_block_stop)$/.test(message.event.type);
}

async function* messagesFrom(query: ReturnType<SdkQuery>): AsyncGenerator<SDKMessage> {
	try {
		for await (const message of query) yield message;
	} finally {
		query.close();
	}
}

/** Resolves managed OAuth immediately before each subprocess spawn and retries only pre-delta failures. */
export async function* queryWithAuthLane(input: AuthenticatedQueryInput): AsyncGenerator<SDKMessage> {
	const pool = await managedPool(input.providerSettings);
	if (!pool) {
		const query = input.query({ prompt: input.prompt, options: input.buildOptions("ambient") });
		input.onQuery?.(query);
		yield* messagesFrom(query);
		return;
	}
	yield* runFailover({
		accounts: pool.accounts,
		selectFn: (accounts) =>
			selectAccount(accounts, {
				sessionId: input.sessionId,
				pinnedAccount: input.pinnedAccount ?? pool.pinnedAccount,
				now: activeBoundary.now(),
			}),
		runAttempt: async (slot) => {
			const options = input.buildOptions(pool.lane);
			options.env = await prepareSlot(pool, slot);
			const query = input.query({ prompt: input.prompt, options });
			input.onQuery?.(query);
			return messagesFrom(query);
		},
		classify: classifySdkError,
		store: pool.store,
		providerId: CLAUDE_AGENT_SDK_PROVIDER_ID,
		now: activeBoundary.now,
		errorFromEvent: sdkFailure,
		isVisibleDelta: visibleSdkMessage,
		onFailover: ({ account, nextAccount, classification }) => {
			emitProviderAccountsChanged(CLAUDE_AGENT_SDK_PROVIDER_ID);
			if (nextAccount) {
				emitProviderAccountFailover(
					CLAUDE_AGENT_SDK_PROVIDER_ID,
					account.name,
					nextAccount.name,
					classification.kind,
				);
			}
		},
	});
}
