import type { ExtensionAPI } from "../../types.ts";

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

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		effective = resolveEffectiveBashTimeouts(baseDefaults, ctx?.getPromptCacheSafeWaitSeconds?.());
		const input = event.input as BashToolInputLike;
		const updated = applyBashTimeout(input, effective);
		if (updated !== input) {
			const timeout = updated.timeout;
			if (timeout !== undefined) input.timeout = timeout;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		effective = resolveEffectiveBashTimeouts(baseDefaults, ctx?.getPromptCacheSafeWaitSeconds?.());
		return { systemPrompt: `${event.systemPrompt}${buildBashTimeoutPrompt(effective)}` };
	});
}
