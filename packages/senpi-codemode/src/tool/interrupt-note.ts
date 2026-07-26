import type { EvalLanguage } from "./types.ts";

const LANGUAGE_LABEL: Record<EvalLanguage, string> = {
	py: "Python kernel",
	js: "JavaScript worker",
	rb: "Ruby kernel",
	jl: "Julia kernel",
};

/**
 * Composes the user-facing note for a cancelled eval cell from the interrupt
 * outcome the kernel actually reported — never a per-language assumption.
 *
 * Returns undefined when there is nothing truthful to add (no interrupt ran).
 */
export function interruptionStateNote(
	language: EvalLanguage,
	stateRetained: boolean | undefined,
): string | undefined {
	if (stateRetained === undefined) return undefined;
	const label = LANGUAGE_LABEL[language];
	if (stateRetained)
		return `${label} was interrupted and remains running; its existing variables are preserved.`;
	return `${label} was unresponsive to interrupt and was restarted; variables from earlier cells are lost.`;
}
