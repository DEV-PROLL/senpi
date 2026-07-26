import type { ExtensionContext } from "../../types.ts";
import { sanitizeTerminalOutput } from "./output-format.ts";
import type { TerminalRuntimeSession } from "./runtime-session.ts";
import type { NotifyMode } from "./settings.ts";
import { describeExit } from "./tools/spawn.ts";

/** Modes that never wake the agent: one-shot, non-interactive runs. */
const NON_INTERACTIVE_MODES = new Set(["print", "json"]);

export interface TerminalNotifierDeps {
	/** Deliver a user-visible completion message with the requested scheduling mode. */
	readonly sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
	readonly getContext: () => ExtensionContext | undefined;
	readonly getMode: () => NotifyMode;
}

/** Max chars of sanitized final output embedded in a completion notification. */
export const NOTICE_TAIL_MAX_CHARS = 2000;

function buildNotice(id: string, runtime: TerminalRuntimeSession): string {
	const status = describeExit(runtime) ?? "exited";
	const code = runtime.exitResult?.exitCode;
	const codeText = code === null || code === undefined ? "" : ` (exit code ${code})`;
	const tail = sanitizeTerminalOutput(runtime.fullOutput()).trimEnd();
	let tailSection = "";
	if (tail.length > 0) {
		const truncated = tail.length > NOTICE_TAIL_MAX_CHARS;
		const shown = truncated ? tail.slice(tail.length - NOTICE_TAIL_MAX_CHARS) : tail;
		const note = truncated
			? `\n[Final output truncated to the last ${NOTICE_TAIL_MAX_CHARS} chars; the full history is still peekable.]`
			: "";
		tailSection = `\nFinal output:\n${shown}${note}`;
	}
	return `<system-reminder>Background terminal session ${id} finished: ${status}${codeText}.${tailSection}</system-reminder>`;
}

/**
 * Notifies an interactive agent once when a background session completes.
 *
 * Guards (todo 23): never wakes in one-shot `-p`/`--print`/`--mode json` runs; never wakes
 * without an active model (would spin an auth-less turn); `notify:"off"` suppresses entirely;
 * each session id fires at most once. `wake` steers immediately; `next-turn` queues a follow-up.
 */
export class TerminalNotifier {
	private readonly notified = new Set<string>();
	private readonly deps: TerminalNotifierDeps;

	constructor(deps: TerminalNotifierDeps) {
		this.deps = deps;
	}

	notifyCompletion(id: string, runtime: TerminalRuntimeSession): void {
		const mode = this.deps.getMode();
		if (mode === "off") return;
		if (this.notified.has(id)) return;

		const ctx = this.deps.getContext();
		if (!ctx) return;
		if (NON_INTERACTIVE_MODES.has(ctx.mode)) return;
		if (!ctx.model) return;

		this.notified.add(id);
		this.deps.sendUserMessage(buildNotice(id, runtime), {
			deliverAs: mode === "wake" ? "steer" : "followUp",
		});
	}
}
