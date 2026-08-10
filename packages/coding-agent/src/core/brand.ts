/**
 * Brand profile resolution.
 *
 * A distribution that repackages this engine (for example the `omo-ai` package) injects a
 * single JSON environment variable describing how the product presents itself. The engine
 * parses it once at startup and then REMOVES it from the environment, so nested processes
 * spawned by tools inherit a clean environment and keep the engine's own identity.
 *
 * Absent or malformed input leaves every brand-derived value at its standalone default, so a
 * plain install behaves exactly as it did before this module existed.
 */

/** Environment variable carrying the JSON brand profile. */
export const BRAND_ENV_VAR = "SENPI_BRAND";

export interface BrandProfile {
	/** Product name shown to users and to the model. */
	readonly name: string;
	/** Version shown in the header, terminal titles and `--version`. */
	readonly displayVersion?: string;
	/** Config directory name, e.g. `.omo`. */
	readonly configDir: string;
	/** When true the agent state lives directly under the config directory, with no `agent` segment. */
	readonly flatLayout: boolean;
	/** Prefix for the product's environment variables, e.g. `OMO`. */
	readonly envPrefix: string;
	/** Product token used in the outgoing user agent. */
	readonly userAgent: string;
	/** Product token used as the provider-side originator, when the distribution overrides it. */
	readonly originator?: string;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Parses a brand profile. Returns undefined for absent, malformed, or nameless input; a
 * malformed profile is reported once on stderr and never throws, because a broken brand
 * must not stop the agent from starting.
 */
export function parseBrandProfile(raw: string | undefined): BrandProfile | undefined {
	if (!raw?.trim()) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		process.stderr.write(`warning: ignoring malformed ${BRAND_ENV_VAR} (expected JSON)\n`);
		return undefined;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		process.stderr.write(`warning: ignoring malformed ${BRAND_ENV_VAR} (expected a JSON object)\n`);
		return undefined;
	}

	const source = parsed as Record<string, unknown>;
	const name = readString(source, "name");
	if (!name) {
		process.stderr.write(`warning: ignoring ${BRAND_ENV_VAR} without a "name"\n`);
		return undefined;
	}

	return {
		name,
		displayVersion: readString(source, "displayVersion"),
		configDir: readString(source, "configDir") || `.${name}`,
		flatLayout: source.flatLayout === true,
		envPrefix: (readString(source, "envPrefix") || name).toUpperCase(),
		userAgent: readString(source, "userAgent") || name,
		originator: readString(source, "originator"),
	};
}

/**
 * Parses the brand profile from an environment and removes the variable from it, so every
 * child process spawned later starts from a clean environment.
 */
export function consumeBrandProfile(env: NodeJS.ProcessEnv = process.env): BrandProfile | undefined {
	const profile = parseBrandProfile(env[BRAND_ENV_VAR]);
	delete env[BRAND_ENV_VAR];
	return profile;
}
