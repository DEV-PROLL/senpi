import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REQUIRED_BUILD_ARTIFACTS = [
	"extensions/omo.js",
	"runtime/lsp-daemon/dist/cli.js",
	"runtime/lsp-daemon/dist/index.js",
	"runtime/lsp-daemon/dist/.omo-runtime-manifest.json",
	"scripts/install.mjs",
] as const;

function walkFiles(rootDir: string): string[] {
	const files: string[] = [];
	const pending = [rootDir];
	while (pending.length > 0) {
		const dir = pending.pop();
		if (dir === undefined) {
			continue;
		}
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			if (error instanceof Error) {
				continue;
			}
			throw error;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				pending.push(full);
			} else if (entry.isFile()) {
				files.push(full);
			}
		}
	}
	return files;
}

export function collectArtifactInventory(pluginPath: string): string[] {
	const inventory: string[] = [];
	const collectUnder = (relativeDir: string, filter?: (posixPath: string) => boolean): void => {
		for (const filePath of walkFiles(join(pluginPath, relativeDir))) {
			const posixPath = relative(pluginPath, filePath).split(sep).join("/");
			if (filter === undefined || filter(posixPath)) {
				inventory.push(posixPath);
			}
		}
	};
	collectUnder("extensions");
	collectUnder(join("runtime", "lsp-daemon", "dist"));
	collectUnder("skills", (posixPath) => posixPath.endsWith("/SKILL.md"));
	if (existsSync(join(pluginPath, "scripts", "install.mjs"))) {
		inventory.push("scripts/install.mjs");
	}
	inventory.sort();
	return inventory;
}

export function currentRequiredBuildArtifactsExist(pluginPath: string): boolean {
	return findMissingBuildArtifacts(pluginPath).length === 0;
}

export function findMissingBuildArtifacts(pluginPath: string): string[] {
	const missing: string[] = [];
	for (const required of REQUIRED_BUILD_ARTIFACTS) {
		if (!existsSync(join(pluginPath, required))) {
			missing.push(required);
		}
	}
	let skillCount = 0;
	try {
		for (const entry of readdirSync(join(pluginPath, "skills"), { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(pluginPath, "skills", entry.name, "SKILL.md"))) {
				skillCount++;
			}
		}
	} catch (error) {
		if (!(error instanceof Error)) {
			throw error;
		}
	}
	if (skillCount === 0) {
		missing.push("skills/*/SKILL.md");
	}
	return missing;
}
