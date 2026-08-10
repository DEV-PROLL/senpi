import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isLocalPath, resolvePath } from "../utils/paths.ts";
import type { PackageSource } from "./settings-manager.ts";

/**
 * Synchronous, dependency-free detection of the "OMO Native" local install: a settings
 * `packages` entry that is a local path resolving to a dir whose package.json name is
 * `@code-yeongyu/omo-senpi`, whose derived repo root (pluginPath/../../..) contains both
 * workspace packages `@oh-my-opencode/omo-senpi` and `@oh-my-opencode/senpi-task`.
 *
 * This mirrors gates 1 and 2 of the beta `detectOmoLocalInstall` (beta/omo-local-update.ts)
 * but drops gate 3 (the `git rev-parse --show-toplevel` integrity check) so it stays sync and
 * cheap enough for footer rendering. The beta module's export policy forbids importing its
 * helpers into production core, so this isolated module is the footer's own detection.
 */
const OMO_SENPI_PLUGIN_PACKAGE = "@code-yeongyu/omo-senpi";
const OMO_SENPI_WORKSPACE_PACKAGE = "@oh-my-opencode/omo-senpi";
const SENPI_TASK_WORKSPACE_PACKAGE = "@oh-my-opencode/senpi-task";

function homeDir(): string {
	return process.env.HOME || homedir();
}

function readPackageName(packageJsonPath: string): string | undefined {
	try {
		const json = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
		const name = json.name;
		return typeof name === "string" ? name : undefined;
	} catch {
		return undefined;
	}
}

export function detectOmoNativeInstall(
	packages: PackageSource[] | undefined,
	agentDir: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	// The omo launcher marks every senpi spawn it owns; omo-ai global installs load the plugin via
	// --extension, so no settings.packages entry ever exists for them and the env marker is the only
	// signal available at footer-render time.
	if (env.OMO_NATIVE === "1") {
		return true;
	}
	if (!packages) {
		return false;
	}
	for (const entry of packages) {
		const source = typeof entry === "string" ? entry : entry.source;
		if (!isLocalPath(source)) {
			continue;
		}
		const pluginPath = resolvePath(source, agentDir, { homeDir: homeDir(), trim: true });
		if (readPackageName(join(pluginPath, "package.json")) !== OMO_SENPI_PLUGIN_PACKAGE) {
			continue;
		}
		const repoRoot = resolve(pluginPath, "..", "..", "..");
		const omoSenpiPkg = join(repoRoot, "packages", "omo-senpi", "package.json");
		if (!existsSync(omoSenpiPkg) || readPackageName(omoSenpiPkg) !== OMO_SENPI_WORKSPACE_PACKAGE) {
			continue;
		}
		const senpiTaskPkg = join(repoRoot, "packages", "senpi-task", "package.json");
		if (!existsSync(senpiTaskPkg) || readPackageName(senpiTaskPkg) !== SENPI_TASK_WORKSPACE_PACKAGE) {
			continue;
		}
		return true;
	}
	return false;
}
