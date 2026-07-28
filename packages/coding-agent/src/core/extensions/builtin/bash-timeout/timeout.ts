export const BASH_DEFAULT_TIMEOUT_SECONDS = 120;
export const BASH_MAX_TIMEOUT_SECONDS = 600;

export interface BashTimeoutDefaults {
	defaultSeconds: number;
	maxSeconds: number;
}

type EnvLike = Record<string, string | undefined>;

function parsePositiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return parsed;
}

export function resolveBashTimeoutDefaults(env: EnvLike): BashTimeoutDefaults {
	const { PI_BASH_DEFAULT_TIMEOUT_SECONDS: defaultTimeout, PI_BASH_MAX_TIMEOUT_SECONDS: maxTimeout } = env;
	const defaultSeconds = parsePositiveInt(defaultTimeout) ?? BASH_DEFAULT_TIMEOUT_SECONDS;
	const rawMax = parsePositiveInt(maxTimeout) ?? BASH_MAX_TIMEOUT_SECONDS;
	const maxSeconds = Math.max(rawMax, defaultSeconds);
	return { defaultSeconds, maxSeconds };
}

export interface BashToolInputLike {
	command: string;
	timeout?: number;
	[key: string]: unknown;
}

export function applyBashTimeout<TInput extends BashToolInputLike>(
	input: TInput,
	defaults: BashTimeoutDefaults,
): TInput {
	const current = input.timeout;
	if (current === undefined || current <= 0) {
		return { ...input, timeout: defaults.defaultSeconds };
	}
	return input;
}

export interface EffectiveBashTimeouts extends BashTimeoutDefaults {
	cacheCapped?: boolean;
}

/**
 * Lower the recommended maximum to the prompt-cache safe-wait budget, so the
 * model is never told to block past the point where the cache expires. The two
 * `min()` expressions are the complete policy: a budget below the injected
 * default pulls that default down with it, keeping the prompt, the injected
 * value, and the terminal detach deadline consistent.
 */
export function resolveEffectiveBashTimeouts(
	defaults: BashTimeoutDefaults,
	safeWaitSeconds: number | undefined,
): Required<EffectiveBashTimeouts> {
	if (safeWaitSeconds === undefined || safeWaitSeconds >= defaults.maxSeconds) {
		return { ...defaults, cacheCapped: false };
	}
	const maxSeconds = Math.min(defaults.maxSeconds, safeWaitSeconds);
	return { defaultSeconds: Math.min(defaults.defaultSeconds, maxSeconds), maxSeconds, cacheCapped: true };
}

export function buildBashTimeoutPrompt(defaults: EffectiveBashTimeouts): string {
	const minutes = (seconds: number): string => (seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`);
	const maxReason = defaults.cacheCapped
		? ` This ceiling is the prompt cache lifetime of the active model minus a safety buffer: blocking past it expires the cache and forces a full re-read on the next request. A foreground command still running at that point is handed to a background session alive instead of being killed.`
		: "";
	return `\n## Bash Tool Timeout Policy\n\nThe \`bash\` tool enforces timeouts even when you omit the \`timeout\` parameter:\n\n- Default timeout: ${defaults.defaultSeconds}s (${minutes(defaults.defaultSeconds)}). Applied automatically when you do not set \`timeout\`.\n- Recommended maximum timeout: ${defaults.maxSeconds}s (${minutes(defaults.maxSeconds)}).${maxReason} Explicit \`timeout\` values are preserved because different hosts may use different timeout units.\n- For long-running commands (builds, installs, test suites), set an explicit \`timeout\` that fits the workload. Do not assume commands run forever.\n- For commands that legitimately need to run beyond the recommended maximum, start them with \`run_in_background: true\` and watch the decisive output with \`monitor\` instead of raising the timeout.\n`;
}
