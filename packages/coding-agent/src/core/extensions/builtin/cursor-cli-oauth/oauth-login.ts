import type {
	AuthCheck,
	AuthContext,
	Credential,
	OAuthAuth,
	OAuthCredential,
	OAuthCredentials,
	OAuthLoginCallbacks,
	ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { cursorProvider } from "@earendil-works/pi-ai/providers/cursor";
import { execFile as nodeExecFile } from "node:child_process";
import { readFile as nodeReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	addAccount,
	emptyCredential,
	listAccounts,
	SENTINEL_OAUTH_FIELDS,
	type CursorCliAccountSlot,
	type CursorCliOauthCredential,
} from "./accounts.ts";
import {
	defaultCursorAgentExecutableDeps,
	resolveCursorAgentExecutable,
	type CursorAgentExecutableDeps,
} from "./executable.ts";
import {
	loadCursorCliOauthProviderSettingsFromDisk,
	type CursorCliOauthProviderSettings,
} from "./settings.ts";

export const CURSOR_CLI_OAUTH_PROVIDER_ID = "cursor-cli-oauth";
export const CURSOR_CLI_OAUTH_NAME = "Cursor CLI (OAuth)";

const NO_ACCOUNTS_MESSAGE = "no accounts: run /login cursor-cli-oauth";
const DISABLED_MESSAGE = "disabled by settings";
const FILE_STORE_LANE = "file-store" as const;
const DEFAULT_IMPORTED_EXPIRY_MS = 60 * 60 * 1000;

type CursorCliOauthSettings = Pick<CursorCliOauthProviderSettings, "enabled" | "executablePath">;

type ImportedCursorCredential = {
	access: string;
	refresh: string;
	expires?: number;
};

export type CursorCliOauthConfigDeps = {
	readCurrent: () => Promise<Credential | undefined>;
	readSettings: () => CursorCliOauthSettings;
	resolveExecutable: (settings: CursorCliOauthSettings) => string;
	loadOAuth?: () => Promise<OAuthAuth>;
	readCursorFile?: () => Promise<ImportedCursorCredential | undefined>;
	readCursorKeychain?: () => Promise<ImportedCursorCredential | undefined>;
};

export type CursorCliOauthLaneResolution = {
	lane: typeof FILE_STORE_LANE;
	account: CursorCliAccountSlot;
	accounts: CursorCliAccountSlot[];
};

export type CursorCliOauthConfig = {
	name: string;
	isSubscription: true;
	check(input: {
		ctx: AuthContext;
		credential?: OAuthCredential;
		signal?: AbortSignal;
	}): Promise<AuthCheck | undefined>;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
};

export type LocalCursorImportDeps = {
	platform?: NodeJS.Platform;
	readCursorFile?: () => Promise<ImportedCursorCredential | undefined>;
	readCursorKeychain?: () => Promise<ImportedCursorCredential | undefined>;
	onPrompt?: OAuthLoginCallbacks["onPrompt"];
};

type ConfigurationAssessment = {
	accounts: CursorCliAccountSlot[];
	message: string;
};

function isCursorCliOauthCredential(value: Credential | OAuthCredentials | undefined): value is CursorCliOauthCredential {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<CursorCliOauthCredential>;
	return candidate.type === "oauth" && Array.isArray(candidate.accounts);
}

function usableAccounts(value: Credential | OAuthCredentials | undefined): CursorCliAccountSlot[] {
	if (!isCursorCliOauthCredential(value)) return [];
	return listAccounts(value).filter(
		(slot) =>
			typeof slot.name === "string" &&
			typeof slot.access === "string" &&
			slot.access.trim().length > 0 &&
			typeof slot.refresh === "string" &&
			slot.refresh.trim().length > 0 &&
			typeof slot.expires === "number" &&
			Number.isFinite(slot.expires),
	);
}

function installationMessage(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `cursor-agent not installed: ${detail.replace(/^Cursor CLI is not installed\.\s*/, "")}`;
}

/** The sole availability predicate used by status checks and turn-time resolution. */
async function configuredFor(deps: CursorCliOauthConfigDeps): Promise<ConfigurationAssessment> {
	const settings = deps.readSettings();
	if (!settings.enabled) throw new Error(DISABLED_MESSAGE);
	try {
		deps.resolveExecutable(settings);
	} catch (error) {
		throw new Error(installationMessage(error));
	}

	const accounts = usableAccounts(await deps.readCurrent());
	if (accounts.length === 0) throw new Error(NO_ACCOUNTS_MESSAGE);
	return {
		accounts,
		message: `configured (file-store, ${accounts.length} accounts)`,
	};
}

/** Resolve credentials immediately before execution so a concurrent refresh cannot leave a stale token in memory. */
export async function resolveCursorCliOauthLane(
	deps: CursorCliOauthConfigDeps,
): Promise<CursorCliOauthLaneResolution> {
	const assessment = await configuredFor(deps);
	const account = assessment.accounts[0];
	if (!account) throw new Error(NO_ACCOUNTS_MESSAGE);
	return { lane: FILE_STORE_LANE, account, accounts: assessment.accounts };
}

async function loadCursorOAuthFlow(): Promise<OAuthAuth> {
	const flow = cursorProvider().auth.oauth;
	if (!flow) throw new Error("Cursor OAuth flow is unavailable");
	return flow;
}

function providerInteraction(callbacks: OAuthLoginCallbacks): ProviderAuthInteraction {
	return {
		signal: callbacks.signal ?? new AbortController().signal,
		prompt: async (prompt) => {
			switch (prompt.type) {
				case "select":
					return (await callbacks.onSelect(prompt)) ?? "";
				case "manual_code":
					return callbacks.onManualCodeInput?.() ?? callbacks.onPrompt(prompt);
				default:
					return callbacks.onPrompt(prompt);
			}
		},
		notify: (event) => {
			switch (event.type) {
				case "auth_url":
					callbacks.onAuth({ url: event.url, instructions: event.instructions });
					break;
				case "device_code":
					callbacks.onDeviceCode(event);
					break;
				case "progress":
					callbacks.onProgress?.(event.message);
					break;
				case "info":
					callbacks.onProgress?.(event.message);
					break;
			}
		},
	};
}

async function accountName(
	existing: CursorCliAccountSlot[],
	onPrompt: OAuthLoginCallbacks["onPrompt"] | undefined,
): Promise<string> {
	if (existing.length === 0) return "default";
	const fallback = `account-${existing.length + 1}`;
	if (!onPrompt) return fallback;
	const answer = (
		await onPrompt({
			message: `Name for this account (existing: ${existing.map((slot) => slot.name).join(", ")})`,
			placeholder: fallback,
		})
	).trim();
	return answer || fallback;
}

function slotFromCredential(
	credential: Pick<OAuthCredentials, "access" | "refresh" | "expires">,
	name: string,
	source: CursorCliAccountSlot["source"],
): CursorCliAccountSlot {
	return {
		name,
		access: credential.access,
		refresh: credential.refresh,
		expires: credential.expires,
		source,
	};
}

export function createCursorCliOauthConfig(deps: CursorCliOauthConfigDeps): CursorCliOauthConfig {
	return {
		name: CURSOR_CLI_OAUTH_NAME,
		isSubscription: true,

		async check() {
			const assessment = await configuredFor(deps);
			return { type: "oauth", source: assessment.message };
		},

		async login(callbacks) {
			const stored = await deps.readCurrent();
			const current = isCursorCliOauthCredential(stored) ? stored : emptyCredential();
			const existing = listAccounts(current);
			const flow = await (deps.loadOAuth ?? loadCursorOAuthFlow)();
			const loggedIn = await flow.login(providerInteraction(callbacks));
			const name = await accountName(existing, callbacks.onPrompt);
			return addAccount(current, slotFromCredential(loggedIn, name, "login"));
		},

		async refreshToken(credentials, signal) {
			if (!isCursorCliOauthCredential(credentials)) return credentials;
			const flow = await (deps.loadOAuth ?? loadCursorOAuthFlow)();
			const accounts: CursorCliAccountSlot[] = [];
			for (const slot of listAccounts(credentials)) {
				if (Date.now() < slot.expires) {
					accounts.push(slot);
					continue;
				}
				const refreshed = await flow.refresh(
					{
						type: "oauth",
						access: slot.access,
						refresh: slot.refresh,
						expires: slot.expires,
					},
					signal,
				);
				accounts.push({ ...slot, access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires });
			}
			return { ...credentials, ...SENTINEL_OAUTH_FIELDS, accounts };
		},

		getApiKey() {
			return SENTINEL_OAUTH_FIELDS.access;
		},
	};
}

function execFileOutput(file: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		nodeExecFile(file, args, { encoding: "utf8" }, (error, stdout) => {
			if (error) {
				resolve(undefined);
				return;
			}
			const value = stdout.trim();
			resolve(value.length > 0 ? value : undefined);
		});
	});
}

async function defaultKeychainCredential(): Promise<ImportedCursorCredential | undefined> {
	if (process.platform !== "darwin") return undefined;
	const [access, refresh] = await Promise.all([
		execFileOutput("security", [
			"find-generic-password",
			"-a",
			"cursor-user",
			"-s",
			"cursor-access-token",
			"-w",
		]),
		execFileOutput("security", [
			"find-generic-password",
			"-a",
			"cursor-user",
			"-s",
			"cursor-refresh-token",
			"-w",
		]),
	]);
	return access && refresh ? { access, refresh } : undefined;
}

function localCursorAuthPath(platform: NodeJS.Platform): string | undefined {
	switch (platform) {
		case "darwin":
			return join(homedir(), ".cursor", "auth.json");
		case "linux":
			return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cursor", "auth.json");
		case "win32": {
			const appData = process.env.APPDATA;
			return appData ? join(appData, "Cursor", "auth.json") : undefined;
		}
		default:
			return undefined;
	}
}

async function defaultFileCredential(platform: NodeJS.Platform): Promise<ImportedCursorCredential | undefined> {
	const path = localCursorAuthPath(platform);
	if (!path) return undefined;
	try {
		const parsed: unknown = JSON.parse(await nodeReadFile(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const record = parsed as Record<string, unknown>;
		const access = record.accessToken;
		const refresh = record.refreshToken;
		if (typeof access !== "string" || access.length === 0 || typeof refresh !== "string" || refresh.length === 0) {
			return undefined;
		}
		return { access, refresh };
	} catch {
		return undefined;
	}
}

/** Explicitly copy the user's local Cursor credential into this provider's managed account slots. */
export async function importLocalCursorCredential(
	current: CursorCliOauthCredential,
	deps: LocalCursorImportDeps = {},
): Promise<CursorCliOauthCredential> {
	const platform = deps.platform ?? process.platform;
	const readKeychain = deps.readCursorKeychain ?? defaultKeychainCredential;
	const readFile = deps.readCursorFile ?? (() => defaultFileCredential(platform));
	const imported = platform === "darwin" ? (await readKeychain()) ?? (await readFile()) : await readFile();
	if (!imported) throw new Error("No local Cursor OAuth credential found");
	const existing = listAccounts(current);
	const name = await accountName(existing, deps.onPrompt);
	return addAccount(
		current,
		slotFromCredential(
			{
				access: imported.access,
				refresh: imported.refresh,
				expires: imported.expires ?? Date.now() + DEFAULT_IMPORTED_EXPIRY_MS,
			},
			name,
			"import",
		),
	);
}

export function defaultCursorCliOauthConfig(
	cwd: string,
	readCurrent: () => Promise<Credential | undefined>,
): CursorCliOauthConfig {
	return createCursorCliOauthConfig({
		readCurrent,
		readSettings: () => loadCursorCliOauthProviderSettingsFromDisk(cwd),
		resolveExecutable: (settings) => {
			const executableDeps: CursorAgentExecutableDeps = {
				...defaultCursorAgentExecutableDeps(),
				settings,
			};
			return resolveCursorAgentExecutable(executableDeps);
		},
	});
}
