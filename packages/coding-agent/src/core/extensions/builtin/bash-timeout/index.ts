import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { isAnthropicBashEnabled } from "../anthropic-bash/index.ts";

import {
	applyBashTimeout,
	type BashToolInputLike,
	buildBashTimeoutPrompt,
	resolveBashTimeoutDefaults,
	resolveEffectiveBashTimeouts,
} from "./timeout.ts";

export type { BashTimeoutDefaults, BashToolInputLike, EffectiveBashTimeouts } from "./timeout.ts";
export {
	applyBashTimeout,
	BASH_DEFAULT_TIMEOUT_SECONDS,
	BASH_MAX_TIMEOUT_SECONDS,
	buildBashTimeoutPrompt,
	resolveBashTimeoutDefaults,
	resolveEffectiveBashTimeouts,
} from "./timeout.ts";

export default function bashTimeoutExtension(pi: ExtensionAPI): void {
	const env = typeof process !== "undefined" ? process.env : {};
	const baseDefaults = resolveBashTimeoutDefaults(env);
	let effective = resolveEffectiveBashTimeouts(baseDefaults, undefined);

	/**
	 * Native Anthropic bash replaces the PTY `bash` tool, and the terminal
	 * extension steps aside with it — so nothing implements the cache-deadline
	 * detach. Advertising a cache ceiling there would promise behavior that
	 * cannot happen, so the budget only applies while the PTY tool is live.
	 */
	const resolveBudget = (ctx: ExtensionContext | undefined): number | undefined => {
		if (isAnthropicBashEnabled() && ctx?.model?.api === "anthropic-messages") return undefined;
		return ctx?.getPromptCacheSafeWaitSeconds?.();
	};

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		effective = resolveEffectiveBashTimeouts(baseDefaults, resolveBudget(ctx));
		const input = event.input as BashToolInputLike;
		const updated = applyBashTimeout(input, effective);
		if (updated !== input) {
			const timeout = updated.timeout;
			if (timeout !== undefined) input.timeout = timeout;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		effective = resolveEffectiveBashTimeouts(baseDefaults, resolveBudget(ctx));
		return { systemPrompt: `${event.systemPrompt}${buildBashTimeoutPrompt(effective)}` };
	});
}
