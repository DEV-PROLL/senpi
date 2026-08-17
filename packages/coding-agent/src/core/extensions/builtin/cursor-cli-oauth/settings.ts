import { getAgentDir } from "../../../../config.ts";
import { type Settings, SettingsManager } from "../../../settings-manager.ts";

export type CursorCliOauthExecutionMode = "agent" | "plan";
export type CursorCliOauthResumeMode = "auto" | "off";

export interface CursorCliOauthProviderSettings {
	readonly enabled: boolean;
	readonly executablePath: string | undefined;
	readonly forceExecution: boolean;
	readonly noApprovalAcknowledgedAt: string | undefined;
	readonly executionMode: CursorCliOauthExecutionMode;
	readonly resumeMode: CursorCliOauthResumeMode;
	readonly pinnedAccount: string | undefined;
	readonly contextRecapOnModelSwitch: boolean;
	readonly modelCatalogTtlHours: number;
	readonly sandboxMode: string | undefined;
}

type SettingsWithCursorCliOauthProvider = Settings & {
	cursorCliOauthProvider?: unknown;
};

type Environment = Readonly<Record<string, string | undefined>>;
type ParsedSettings = Partial<CursorCliOauthProviderSettings>;

const DEFAULT_SETTINGS: CursorCliOauthProviderSettings = {
	enabled: false,
	executablePath: undefined,
	forceExecution: true,
	noApprovalAcknowledgedAt: undefined,
	executionMode: "agent",
	resumeMode: "auto",
	pinnedAccount: undefined,
	contextRecapOnModelSwitch: true,
	modelCatalogTtlHours: 24,
	sandboxMode: undefined,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function parseEnvironmentBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	switch (value.toLowerCase()) {
		case "1":
		case "true":
			return true;
		case "0":
		case "false":
			return false;
		default:
			return undefined;
	}
}

function parseNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseIsoString(value: unknown): string | undefined {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
		return undefined;
	}
	return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function parseExecutionMode(value: unknown): CursorCliOauthExecutionMode | undefined {
	return value === "agent" || value === "plan" ? value : undefined;
}

function parseResumeMode(value: unknown): CursorCliOauthResumeMode | undefined {
	return value === "auto" || value === "off" ? value : undefined;
}

function parsePositiveFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseEnvironmentPositiveFiniteNumber(value: string | undefined): number | undefined {
	if (value === undefined || value.length === 0) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseProviderSettings(value: unknown): ParsedSettings {
	if (!isRecord(value)) return {};
	const enabled = parseBoolean(value.enabled);
	const executablePath = parseNonEmptyString(value.executablePath);
	const forceExecution = parseBoolean(value.forceExecution);
	const noApprovalAcknowledgedAt = parseIsoString(value.noApprovalAcknowledgedAt);
	const executionMode = parseExecutionMode(value.executionMode);
	const resumeMode = parseResumeMode(value.resumeMode);
	const pinnedAccount = parseNonEmptyString(value.pinnedAccount);
	const contextRecapOnModelSwitch = parseBoolean(value.contextRecapOnModelSwitch);
	const modelCatalogTtlHours = parsePositiveFiniteNumber(value.modelCatalogTtlHours);
	const sandboxMode = parseNonEmptyString(value.sandboxMode);
	return {
		...(enabled !== undefined ? { enabled } : {}),
		...(executablePath !== undefined ? { executablePath } : {}),
		...(forceExecution !== undefined ? { forceExecution } : {}),
		...(noApprovalAcknowledgedAt !== undefined ? { noApprovalAcknowledgedAt } : {}),
		...(executionMode !== undefined ? { executionMode } : {}),
		...(resumeMode !== undefined ? { resumeMode } : {}),
		...(pinnedAccount !== undefined ? { pinnedAccount } : {}),
		...(contextRecapOnModelSwitch !== undefined ? { contextRecapOnModelSwitch } : {}),
		...(modelCatalogTtlHours !== undefined ? { modelCatalogTtlHours } : {}),
		...(sandboxMode !== undefined ? { sandboxMode } : {}),
	};
}

function parseEnvironmentSettings(environment: Environment): ParsedSettings {
	const executablePath =
		parseNonEmptyString(environment.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE) ??
		parseNonEmptyString(environment.CURSOR_AGENT_EXECUTABLE);
	const enabled = parseEnvironmentBoolean(environment.SENPI_CURSOR_CLI_OAUTH_ENABLED);
	const forceExecution = parseEnvironmentBoolean(environment.SENPI_CURSOR_CLI_OAUTH_FORCE);
	const executionMode = parseExecutionMode(environment.SENPI_CURSOR_CLI_OAUTH_EXECUTION_MODE);
	const resumeMode = parseResumeMode(environment.SENPI_CURSOR_CLI_OAUTH_RESUME);
	const pinnedAccount = parseNonEmptyString(environment.SENPI_CURSOR_CLI_OAUTH_PINNED_ACCOUNT);
	const contextRecapOnModelSwitch = parseEnvironmentBoolean(environment.SENPI_CURSOR_CLI_OAUTH_RECAP);
	const modelCatalogTtlHours = parseEnvironmentPositiveFiniteNumber(
		environment.SENPI_CURSOR_CLI_OAUTH_MODEL_CATALOG_TTL_HOURS,
	);
	const sandboxMode = parseNonEmptyString(environment.SENPI_CURSOR_CLI_OAUTH_SANDBOX_MODE);
	return {
		...(executablePath !== undefined ? { executablePath } : {}),
		...(enabled !== undefined ? { enabled } : {}),
		...(forceExecution !== undefined ? { forceExecution } : {}),
		...(executionMode !== undefined ? { executionMode } : {}),
		...(resumeMode !== undefined ? { resumeMode } : {}),
		...(pinnedAccount !== undefined ? { pinnedAccount } : {}),
		...(contextRecapOnModelSwitch !== undefined ? { contextRecapOnModelSwitch } : {}),
		...(modelCatalogTtlHours !== undefined ? { modelCatalogTtlHours } : {}),
		...(sandboxMode !== undefined ? { sandboxMode } : {}),
	};
}

function resolveSettings(...layers: readonly ParsedSettings[]): CursorCliOauthProviderSettings {
	return Object.assign({}, DEFAULT_SETTINGS, ...layers);
}

/** Parse one provider settings block with environment values taking precedence. */
export function parseCursorCliOauthProviderSettings(
	value: unknown,
	environment: Environment,
): CursorCliOauthProviderSettings {
	return resolveSettings(parseProviderSettings(value), parseEnvironmentSettings(environment));
}

/**
 * Build the probe-owned sandbox allowlist validator without hardcoding modes in settings parsing.
 * Each distinct rejected mode is reported once through the supplied warning hook.
 */
export function createCursorCliOauthSandboxModeValidator(
	acceptedModes: ReadonlySet<string>,
	onWarning: (message: string) => void,
): (value: string | undefined) => string | undefined {
	const warnedModes = new Set<string>();
	return (value) => {
		if (value === undefined || acceptedModes.has(value)) return value;
		if (!warnedModes.has(value)) {
			warnedModes.add(value);
			onWarning(`Ignoring unrecognized Cursor CLI OAuth sandbox mode: ${value}`);
		}
		return undefined;
	};
}

/** Load global and project settings afresh, with env values taking final precedence. */
export function loadCursorCliOauthProviderSettingsFromDisk(cwd: string): CursorCliOauthProviderSettings {
	const settingsManager = SettingsManager.create(cwd, getAgentDir());
	const global = settingsManager.getGlobalSettings() as SettingsWithCursorCliOauthProvider;
	const project = settingsManager.getProjectSettings() as SettingsWithCursorCliOauthProvider;
	return resolveSettings(
		parseProviderSettings(global.cursorCliOauthProvider),
		parseProviderSettings(project.cursorCliOauthProvider),
		parseEnvironmentSettings(process.env),
	);
}
