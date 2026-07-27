import { sep } from "node:path";

const SUBDIRECTORY_ENTRY_NAMES = ["index.ts", "index.js", "package.json"] as const;

function isExtensionSource(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Mirrors `discoverExtensionsInDir` in `../../loader.ts`, which never recurses
 * past one level. Anything deeper is extension runtime state, not configuration:
 * the goal extension persists `extensions/goal/<scope>/<id>.json`, and watching
 * it turned every goal tool call into a full session reload.
 */
export function isLoadableExtensionEntry(relativePath: string): boolean {
	const segments = relativePath.split(sep).filter((segment) => segment !== "");
	const [first, second] = segments;
	if (first === undefined) return false;
	if (segments.length === 1) return isExtensionSource(first);
	if (segments.length === 2) {
		return SUBDIRECTORY_ENTRY_NAMES.some((entryName) => entryName === second);
	}
	return false;
}

export function isScannableExtensionDirectory(relativePath: string): boolean {
	if (relativePath === "") return true;
	return !relativePath.includes(sep);
}
