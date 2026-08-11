import { spawn } from "node:child_process";
import { defaultExecutableDeps, resolveClaudeCodeExecutable } from "./executable.ts";

/** Long enough to keep the probe off the per-request path, short enough that a fresh `claude login` is picked up promptly. */
const AMBIENT_STATUS_TTL_MS = 30_000;

/**
 * Memoises the probe, which spawns the Claude binary and costs a few hundred
 * milliseconds. Auth resolution runs per request, so an uncached probe would
 * put that on every model call. Concurrent readers share one in-flight probe;
 * a rejected probe is not cached.
 */
export function createAmbientAuthStatusReader(
	probe: () => Promise<boolean>,
	now: () => number = Date.now,
	ttlMs: number = AMBIENT_STATUS_TTL_MS,
): () => Promise<boolean> {
	let cached: { at: number; value: Promise<boolean> } | undefined;
	return () => {
		if (cached && now() - cached.at < ttlMs) return cached.value;
		const value = probe();
		cached = { at: now(), value };
		value.catch(() => {
			if (cached?.value === value) cached = undefined;
		});
		return value;
	};
}

export async function probeAmbientClaudeAuthStatus(): Promise<boolean> {
	let executable: string;
	try {
		executable = resolveClaudeCodeExecutable(defaultExecutableDeps());
	} catch {
		return false;
	}

	return new Promise((resolve) => {
		let settled = false;
		const finish = (available: boolean) => {
			if (settled) return;
			settled = true;
			resolve(available);
		};
		const child = spawn(executable, ["auth", "status"], { stdio: "ignore" });
		child.once("error", () => finish(false));
		child.once("close", (code) => finish(code === 0));
	});
}

export const readAmbientClaudeAuthStatus = createAmbientAuthStatusReader(probeAmbientClaudeAuthStatus);
