// Claude Opus 5 preset. Thin tuningSection over the shared dynamic core, per
// the Claude lineage (claude-opus-4-{5..8}.ts, claude-fable-5.ts): Anthropic's
// Opus 5 prompting guide says the model "performs well out of the box on
// existing Claude Opus 4.8 prompts", and 4.8 runs this same shared core, so a
// full corePrompt rewrite (a GPT-5.5/5.6 doctrine) is not warranted.
//
// Every paragraph maps to a documented Opus 5 behavior
// (platform.claude.com/docs/.../prompting-claude-opus-5) or a harness fact the
// model cannot derive:
// - Declared stop condition: binding stop contract adapted from the GPT-5.6
//   preset. Opus 5's two documented failure modes - scope expansion and
//   over-verification - are both "actions past the stop goal", so one contract
//   subsumes both: think through the goal, say the observable end state in the
//   routing line, stop the instant it holds.
// - Scope: the guide's own constraint against quietly narrowing, widening, or
//   transforming the task. The 4.7/4.8 scope-literalism line ("every" means
//   the full set) is intentionally dropped - Opus 5's failure mode inverted
//   from under-scoping to over-scoping.
// - Bounded verification: Opus 5 verifies its own work unprompted; explicit
//   re-check instructions compound into over-verification, so the tuning bounds
//   the shared verification tiers to one pass and bans post-stop re-checks.
// - Delegation caps: Opus 5 delegates more readily than prior models; phrased
//   conditionally ("when a delegation tool is available") because base senpi
//   exposes no spawn surface - the clause is inert without one.
// - Narration cadence + late conciseness reminder: Opus 5 narrates readily and
//   runs longer responses; the guide recommends a short reminder near the end
//   of a long prompt, which is exactly where tuningSection lands.
// - Correction filter and deliverable-length calibration: verbatim guide
//   recommendations, trimmed.
// - Auto-compaction: harness fact carried from the whole Claude lineage,
//   retargeted at the declared stop condition.
// NOT carried from 4.7/4.8: tool-use-over-reasoning nudge (Opus 5 is already
// tool-forward) and the cream/serif/terracotta design counter (undocumented
// for Opus 5). NOT added: thinking-disabled artifact mitigations (senpi runs
// Claude with thinking enabled; the guide's primary mitigation IS keeping
// thinking on).

import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.ts";

function buildClaudeOpus5Tuning(): string {
	return `Extend the routing line with a declared stop condition: "I read this as [intent] - [plan]. I'll stop when [the exact, observable condition that ends this turn]." Before naming it, think hard about what the goal actually is - the end state the user can observe, not a step count. Once declared, the condition is binding.

Deliver the task at the scope asked. Make routine judgment calls yourself, and check in only when different readings of the request would lead to materially different work. If the request seems mistaken or a better approach exists, say so in a sentence and continue as asked rather than quietly narrowing, widening, or transforming the work. Finish the whole task, and stop short of actions clearly beyond it.

You verify your own work by default; keep it bounded. Run the verification tier that matches the change once and trust a green result. The moment your declared stop condition holds, check it against evidence you already captured - no new verification - deliver the final message, and stop. Stopping is mandatory and immediate: no extra verification pass, no re-polish, no bonus refactor, no unrequested follow-up. Every action past the declared stop condition is a defect, not diligence.

Delegate only sizeable, genuinely independent tracks of work, and only when a delegation tool is available. Keep work you can finish in a handful of tool calls, never spawn subagents to verify your own work, and prefer one subagent over several.

While working, add a progress note only when you find something important or change direction - the routing line already announced the plan. Keep responses focused and reasonably concise. Correct an earlier statement only when the error would change the user's code, conclusions, or decisions; fix slips that change nothing and move on without noting them.

Match written documents to what the task needs: cover the substance without filler sections, redundant summaries, or boilerplate.

Do not wrap up early because the context window is running low; the harness auto-compacts context. Keep working until your declared stop condition is met.`;
}

export function buildClaudeOpus5Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({
		...options,
		tuningSection: buildClaudeOpus5Tuning(),
		workstationDialect: "claude",
	});
}
