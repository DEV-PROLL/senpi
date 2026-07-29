import { homedir } from "os";
import { join } from "path";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR, isBunBinary } from "./config.ts";

const SOURCE_MODULE_PATTERN = /\.(ts|mts|cts|tsx)$/;

export function isFromSourceRun(moduleUrl: string = import.meta.url, bunBinary: boolean = isBunBinary): boolean {
	return !bunBinary && SOURCE_MODULE_PATTERN.test(moduleUrl);
}

export function targetsRealUserAgentDir(
	agentDir: string,
	envAgentDir: string | undefined = process.env[ENV_AGENT_DIR],
	homeDir: string = homedir(),
): boolean {
	return !envAgentDir && agentDir === join(homeDir, CONFIG_DIR_NAME, "agent");
}

/**
 * A run from TypeScript sources (dev/QA) that resolves to the real user agent
 * dir is the exact setup that has leaked writes into real user config before.
 * Returns the warning to print, or undefined when the run is safe.
 */
export function getFromSourceRealConfigWarning(
	agentDir: string,
	moduleUrl: string = import.meta.url,
	envAgentDir: string | undefined = process.env[ENV_AGENT_DIR],
	homeDir: string = homedir(),
	bunBinary: boolean = isBunBinary,
): string | undefined {
	if (!isFromSourceRun(moduleUrl, bunBinary) || !targetsRealUserAgentDir(agentDir, envAgentDir, homeDir)) {
		return undefined;
	}
	return `Warning: running from source against the real user config (${agentDir}). Set ${ENV_AGENT_DIR} to an isolated directory for dev and QA runs.`;
}
