import { getAgentDir } from "../../../../config.ts";
import { type Settings, SettingsManager } from "../../../settings-manager.ts";
import type { SettingSource } from "./sdk-boundary.ts";

export type ClaudeAgentSdkTokenInjection = "oauth-slots" | "config-dir" | "ambient";

export interface ClaudeAgentSdkProviderSettings {
	readonly appendSystemPrompt?: boolean;
	readonly settingSources?: SettingSource[];
	readonly strictMcpConfig?: boolean;
	readonly pinnedAccount?: string;
	readonly tokenInjection?: ClaudeAgentSdkTokenInjection;
}

type SettingsWithClaudeAgentSdkProvider = Settings & {
	claudeAgentSdkProvider?: unknown;
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

function parseTokenInjection(value: unknown): ClaudeAgentSdkTokenInjection | undefined {
	return value === "oauth-slots" || value === "config-dir" || value === "ambient" ? value : undefined;
}

function parseProviderSettings(value: unknown): ClaudeAgentSdkProviderSettings {
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
export function loadClaudeAgentSdkProviderSettings(settingsManager: SettingsManager): ClaudeAgentSdkProviderSettings {
	const global = settingsManager.getGlobalSettings() as SettingsWithClaudeAgentSdkProvider;
	const project = settingsManager.getProjectSettings() as SettingsWithClaudeAgentSdkProvider;
	return {
		...parseProviderSettings(global.claudeAgentSdkProvider),
		...parseProviderSettings(project.claudeAgentSdkProvider),
	};
}

/** Load settings from Senpi's configured global and project settings.json paths. */
export function loadClaudeAgentSdkProviderSettingsFromDisk(cwd: string): ClaudeAgentSdkProviderSettings {
	return loadClaudeAgentSdkProviderSettings(SettingsManager.create(cwd, getAgentDir()));
}
