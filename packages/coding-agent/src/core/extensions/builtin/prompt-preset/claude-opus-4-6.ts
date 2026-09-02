import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.ts";
import { buildExecutionToolingSection } from "./execution-tooling.ts";

function buildClaudeOpus46Tuning(): string {
	return `Choose an approach and commit to it; revisit only when new information directly contradicts your reasoning. When a request covers a set of items, apply it to every item and state the scope you applied.

Do not wrap up early because the context window is running low; the harness auto-compacts context. Keep working until the task is complete.`;
}

export function buildClaudeOpus46Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({
		...options,
		tuningSection: [
			buildExecutionToolingSection({ toolNames: options.selectedTools, dialect: "claude" }),
			buildClaudeOpus46Tuning(),
		]
			.filter((section) => section.length > 0)
			.join("\n\n"),
		workstationDialect: "claude",
	});
}
