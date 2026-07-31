import { getAgentDir } from "../../../../config.ts";
import { type Settings, SettingsManager } from "../../../settings-manager.ts";
import type { SettingSource } from "./sdk-boundary.ts";

export type ClaudeSdkOauthTokenInjection = "oauth-slots" | "config-dir" | "ambient";

export interface ClaudeSdkOauthProviderSettings {
	readonly appendSystemPrompt?: boolean;
	readonly settingSources?: SettingSource[];
	readonly strictMcpConfig?: boolean;
	readonly pinnedAccount?: string;
	readonly tokenInjection?: ClaudeSdkOauthTokenInjection;
}

type SettingsWithClaudeSdkOauthProvider = Settings & {
	claudeSdkOauthProvider?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettingSources(value: unknown): SettingSource[] | undefined {
	if (!Array.isArray(value)) return undefined;
	if (!value.every((source) => source === "user" || source === "project" || source === "local")) {
		return undefined;
	}
	return [...value];
}

function parseTokenInjection(value: unknown): ClaudeSdkOauthTokenInjection | undefined {
	return value === "oauth-slots" || value === "config-dir" || value === "ambient" ? value : undefined;
}

function parseProviderSettings(value: unknown): ClaudeSdkOauthProviderSettings {
	if (!isRecord(value)) return {};
	return {
		appendSystemPrompt: typeof value.appendSystemPrompt === "boolean" ? value.appendSystemPrompt : undefined,
		settingSources: parseSettingSources(value.settingSources),
		strictMcpConfig: typeof value.strictMcpConfig === "boolean" ? value.strictMcpConfig : undefined,
		pinnedAccount:
			typeof value.pinnedAccount === "string" && value.pinnedAccount.length > 0 ? value.pinnedAccount : undefined,
		tokenInjection: parseTokenInjection(value.tokenInjection),
	};
}

/** Load the provider block with project values taking precedence over global values. */
export function loadClaudeSdkOauthProviderSettings(settingsManager: SettingsManager): ClaudeSdkOauthProviderSettings {
	const global = settingsManager.getGlobalSettings() as SettingsWithClaudeSdkOauthProvider;
	const project = settingsManager.getProjectSettings() as SettingsWithClaudeSdkOauthProvider;
	return {
		...parseProviderSettings(global.claudeSdkOauthProvider),
		...parseProviderSettings(project.claudeSdkOauthProvider),
	};
}

/** Load settings from Senpi's configured global and project settings.json paths. */
export function loadClaudeSdkOauthProviderSettingsFromDisk(cwd: string): ClaudeSdkOauthProviderSettings {
	return loadClaudeSdkOauthProviderSettings(SettingsManager.create(cwd, getAgentDir()));
}
