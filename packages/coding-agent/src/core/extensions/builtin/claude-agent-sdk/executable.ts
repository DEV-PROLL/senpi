import { createRequire } from "node:module";

export type ExecutableDeps = {
	platform: string;
	arch: string;
	env: (name: string) => string | undefined;
	resolve: (spec: string) => string;
	isCompiledBun?: () => boolean;
	extractFromBunfs?: (embeddedPath: string) => string;
};

export function claudeCodeExecutableCandidates(platform: string, arch: string): string[] {
	const ext = platform === "win32" ? ".exe" : "";
	if (platform === "linux") {
		return [
			`@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude${ext}`,
			`@anthropic-ai/claude-agent-sdk-linux-${arch}/claude${ext}`,
		];
	}
	return [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${ext}`];
}

function firstResolvable(candidates: string[], resolve: (spec: string) => string): string | undefined {
	for (const candidate of candidates) {
		try {
			return resolve(candidate);
		} catch {
			// try next candidate
		}
	}
	return undefined;
}

export function resolveClaudeCodeExecutable(deps: ExecutableDeps): string {
	const override = deps.env("CLAUDE_CODE_EXECUTABLE");
	if (override) return override;

	const candidates = claudeCodeExecutableCandidates(deps.platform, deps.arch);

	if (deps.isCompiledBun?.() && deps.extractFromBunfs) {
		const embedded = firstResolvable(candidates, deps.resolve);
		if (embedded !== undefined) {
			try {
				return deps.extractFromBunfs(embedded);
			} catch {
				// not embedded in the bundle - fall through to the on-disk probe
			}
		}
	}

	const resolved = firstResolvable(candidates, deps.resolve);
	if (resolved !== undefined) return resolved;

	throw new Error(
		`Claude native binary not found for ${deps.platform}-${deps.arch}. ` +
			"Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set CLAUDE_CODE_EXECUTABLE.",
	);
}

let defaultRequire: ReturnType<typeof createRequire> | null = null;

export function defaultExecutableDeps(): ExecutableDeps {
	return {
		platform: process.platform,
		arch: process.arch,
		env: (name) => process.env[name],
		resolve: (spec) => {
			if (!defaultRequire) {
				defaultRequire = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
			}
			return defaultRequire.resolve(spec);
		},
	};
}
