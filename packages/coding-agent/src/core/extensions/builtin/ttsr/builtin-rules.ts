import type { TtsrRule } from "./types.ts";

export const FABRICATED_UNAVAILABLE_TOOL_CALL_RULE_NAME = "fabricated-unavailable-tool-call";

export const BUILTIN_TTSR_RULES: readonly TtsrRule[] = [
	{
		name: FABRICATED_UNAVAILABLE_TOOL_CALL_RULE_NAME,
		content: [
			"Your previous output imitated an unavailable historical tool call as inert text instead of taking action.",
			"Redo the interrupted step now. Call your real tools that are actually available to you, such as edit or write for file changes.",
			"Do not print or imitate unavailable-tool transcript envelopes.",
		].join("\n"),
		description: "Interrupt fabricated unavailable-tool calls emitted as assistant text.",
		condition: [
			"(?i)<\\s*unavailable-tool-call\\b",
			"(?i)\\[called\\s+tool\\s+[\"'][^\"'\\r\\n]+[\"']\\s+\\(no\\s+longer\\s+available\\s+in\\s+this\\s+session\\)",
		],
		scope: { allowText: true, allowThinking: false, toolScopes: [] },
		interruptMode: "always",
		source: "builtin",
	},
];
