import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** How long `bun --version` may run before the PATH probe gives up. */
const PATH_BUN_PROBE_TIMEOUT_MS = 1500;

const BUN_SKILL_BASE_DIR = dirname(fileURLToPath(import.meta.url));

let loggedMissingBunSkill = false;

export const BUN_SKILL_MIN_VERSION = "1.4.0";

export interface BunSkillProbe {
	probePathBunVersion(): Promise<string | undefined>;
	runtimeBunVersion(): string | undefined;
}

/**
 * True when the version is at least `BUN_SKILL_MIN_VERSION`: parses the leading
 * `<major>.<minor>` integers of the string and gates on major > 1 || (major === 1 && minor >= 4).
 * Unparseable or missing versions never enable the skill.
 */
export function bunVersionSupportsSkill(version: string | undefined): boolean {
	if (version === undefined) return false;
	const match = /^(\d+)\.(\d+)/.exec(version);
	if (match === null) return false;
	const major = Number.parseInt(match[1]!, 10);
	const minor = Number.parseInt(match[2]!, 10);
	return major > 1 || (major === 1 && minor >= 4);
}

/** Absolute path of the bundled bun-1-4 SKILL.md, or undefined (logged once) when it is not shipped. */
export function bundledBunSkillPath(baseDir: string = BUN_SKILL_BASE_DIR): string | undefined {
	const candidate = join(baseDir, "..", "skill", "bun-1-4", "SKILL.md");
	if (existsSync(candidate)) return candidate;
	if (!loggedMissingBunSkill) {
		loggedMissingBunSkill = true;
		console.debug(`[senpi-codemode] bundled bun-1-4 skill not found at ${candidate}; skipping contribution`);
	}
	return undefined;
}

async function probePathBunVersion(): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("bun", ["--version"], { timeout: PATH_BUN_PROBE_TIMEOUT_MS });
		return stdout.trim();
	} catch {
		return undefined;
	}
}

const defaultBunSkillProbe: BunSkillProbe = {
	probePathBunVersion,
	runtimeBunVersion: () => process.versions.bun,
};

/**
 * Builds the `resources_discover` handler that contributes the bundled bun-1-4 skill
 * when bun >= 1.4 is detected (PATH probe first, `process.versions.bun` as fallback).
 * The gate decision is cached in a single shared promise, so the PATH probe
 * subprocess runs at most once per handler.
 */
export function createBunSkillDiscoverHandler(
	probe: BunSkillProbe = defaultBunSkillProbe,
	baseDir?: string,
): () => Promise<{ skillPaths: string[] } | undefined> {
	let decision: Promise<{ skillPaths: string[] } | undefined> | undefined;
	return async () => {
		decision ??= (async () => {
			const version = (await probe.probePathBunVersion()) ?? probe.runtimeBunVersion();
			if (!bunVersionSupportsSkill(version)) return undefined;
			const skillPath = bundledBunSkillPath(baseDir);
			return skillPath === undefined ? undefined : { skillPaths: [skillPath] };
		})();
		return decision;
	};
}

export function registerBunSkillContribution(
	pi: {
		on(
			event: "resources_discover",
			handler: (
				event: unknown,
				ctx: unknown,
			) => Promise<{ skillPaths?: string[] } | undefined> | { skillPaths?: string[] } | undefined,
		): void;
	},
	probe?: BunSkillProbe,
	baseDir?: string,
): void {
	pi.on("resources_discover", createBunSkillDiscoverHandler(probe, baseDir));
}
