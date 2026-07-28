import { lstatSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

export const MAX_PARENT_CONFIG_SEARCH_DEPTH = 100;

function isDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Finds the nearest non-symlinked config directory between cwd and home.
 * Home is excluded so its config remains the global fallback layer.
 */
export function findNearestParentConfigDir(
	cwd: string,
	homeDir: string,
	configDirName: string,
	requiredChildDir?: string,
): string | undefined {
	const normalizedHomeDir = normalize(homeDir);
	let currentDir = normalize(cwd);

	for (let depth = 0; depth <= MAX_PARENT_CONFIG_SEARCH_DEPTH; depth += 1) {
		if (currentDir === normalizedHomeDir) {
			return undefined;
		}

		const configDir = join(currentDir, configDirName);
		if (isDirectory(configDir) && (!requiredChildDir || isDirectory(join(configDir, requiredChildDir)))) {
			return configDir;
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return undefined;
		}
		currentDir = parentDir;
	}

	return undefined;
}
