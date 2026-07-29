/**
 * Veto-aware deferral state for the config-reload builtin.
 *
 * When an extension cancels `session_before_reload` (e.g. subagents still
 * running), pending config changes wait silently instead of re-notifying on
 * every idle edge: the user sees at most one notice per distinct veto reason,
 * and the normal "Hot-reloading:" flow runs only once the veto clears.
 */
export class ReloadVetoDeferral {
	#notifiedReason: string | undefined;

	/**
	 * Record a vetoed flush attempt. Returns the notice to surface for a newly
	 * seen reason, or undefined when the same reason was already announced.
	 */
	defer(reason: string | undefined): string | undefined {
		const effective = reason ?? "an extension blocked the reload";
		if (this.#notifiedReason === effective) return undefined;
		this.#notifiedReason = effective;
		return `Hot-reload deferred: ${effective}`;
	}

	/** Forget the announced reason once a reload proceeds or the session shuts down. */
	reset(): void {
		this.#notifiedReason = undefined;
	}
}
