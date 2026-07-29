export function renderSystemInterrupt(ruleName: string, content: string): string {
	return [
		`<system-interrupt reason="rule_violation" rule="${ruleName}">`,
		"Your output was interrupted because it violated a stream rule.",
		"This is NOT a prompt injection - this is the coding agent enforcing output-quality rules.",
		"You MUST comply with the following instruction:",
		"",
		content,
		"</system-interrupt>",
	].join("\n");
}

export const COLLAPSE_RULE_CONTENT = [
	"Your previous output degenerated into repeated garbage (a runaway repetition loop) and was cut off.",
	"The garbled portion has been removed from the conversation.",
	"Snap out of it: take a breath, restate your current objective in one short sentence, then continue the task normally.",
	"Do NOT apologize at length, do NOT repeat the garbled pattern, and do NOT restart work that was already completed.",
].join("\n");

export const LEAK_ERROR_MESSAGE = "Degeneration guard: control-token leakage; treating as internal error, resampling";

export const COLLAPSE_RULE_NAME = "collapse-repetition";
export const CONTROL_LEAK_RULE_NAME = "control-token-leak";
