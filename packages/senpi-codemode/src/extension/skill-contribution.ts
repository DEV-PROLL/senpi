export const BUN_SKILL_MIN_VERSION = "1.4.0";

export interface BunSkillProbe {
	probePathBunVersion(): Promise<string | undefined>;
	runtimeBunVersion(): string | undefined;
}

export function bunVersionSupportsSkill(version: string | undefined): boolean {
	void version;
	return false;
}

export function bundledBunSkillPath(baseDir?: string): string | undefined {
	void baseDir;
	return undefined;
}

export function createBunSkillDiscoverHandler(
	probe?: BunSkillProbe,
	baseDir?: string,
): () => Promise<{ skillPaths: string[] } | undefined> {
	void probe;
	void baseDir;
	return async () => undefined;
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
	void probe;
	void baseDir;
	pi.on("resources_discover", async () => undefined);
}
