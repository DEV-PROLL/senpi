import { defaultConfig } from "./rules/engine.ts";
import type { PiRulesConfig } from "./rules/types.ts";

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

export function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): PiRulesConfig {
	const config = defaultConfig();
	const disabled = readEnv(env, "PI_RULES_DISABLED");
	config.disabled = disabled !== undefined && TRUTHY_VALUES.has(disabled.trim().toLowerCase());
	config.maxRuleChars = parsePositiveInteger(readEnv(env, "PI_RULES_MAX_RULE_CHARS")) ?? config.maxRuleChars;
	config.maxResultChars = parsePositiveInteger(readEnv(env, "PI_RULES_MAX_RESULT_CHARS")) ?? config.maxResultChars;
	return config;
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!/^\d+$/.test(normalized)) return undefined;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
