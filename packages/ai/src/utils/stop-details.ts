import type { AssistantMessage } from "../types.ts";

const ANTHROPIC_POLICY_REFUSAL_PATTERN =
	/This request triggered restrictions on [\s\S]+? and was blocked under Anthropic's Usage Policy\b/i;

/** Returns true when an assistant response represents a refusal or sensitive stop. */
export function isClassifierRefusal(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" && message.stopReason !== "toolUse") return false;
	if (message.stopDetails?.type === "refusal" || message.stopDetails?.type === "sensitive") return true;
	return message.errorMessage ? ANTHROPIC_POLICY_REFUSAL_PATTERN.test(message.errorMessage) : false;
}
