import type { Message } from "@earendil-works/pi-ai";

/**
 * Normalizes a summarization request's final message list so strict
 * turn-alternation providers (Gemini) accept it. Gemini rejects a functionCall
 * model turn that follows another model turn, and rejects any conversation
 * whose first turn is not a user turn — both shapes occur in real
 * summarization inputs:
 *
 * - sessions contain adjacent assistant messages (split turns, retries), and
 * - budget pruning / overflow shrinking can drop the leading user message.
 *
 * This runs on the converted LLM message list (after convertToLlm and pair
 * repair), where context-excluded entries are already dropped and roles are
 * final. Two repairs, in order:
 *
 * 1. Adjacent assistant messages are merged into one (content concatenated).
 *    Messages with stopReason error/aborted are left alone: downstream
 *    provider transforms drop them, which heals the ordering on its own, and
 *    merging would replay partial content those transforms intentionally
 *    discard.
 * 2. Everything before the first user message is dropped. Budget pruning has
 *    already judged the oldest content expendable; a leading assistant /
 *    toolResult fragment would only produce a provider rejection.
 */
export function normalizeSummarizationTurnOrder(messages: Message[]): Message[] {
	const merged: Message[] = [];
	for (const message of messages) {
		const previous = merged[merged.length - 1];
		if (
			previous?.role === "assistant" &&
			message.role === "assistant" &&
			isMergeable(previous) &&
			isMergeable(message)
		) {
			merged[merged.length - 1] = mergeAssistantPair(previous, message);
			continue;
		}
		merged.push(message);
	}
	const firstUserIndex = merged.findIndex((message) => message.role === "user");
	if (firstUserIndex === -1) return merged;
	return merged.slice(firstUserIndex);
}

function isMergeable(message: Message): boolean {
	if (message.role !== "assistant") return false;
	const stopReason = (message as { stopReason?: string }).stopReason;
	return stopReason !== "error" && stopReason !== "aborted";
}

function mergeAssistantPair(first: Message, second: Message): Message {
	const firstContent = (first as { content?: unknown }).content;
	const secondContent = (second as { content?: unknown }).content;
	if (!Array.isArray(firstContent) || !Array.isArray(secondContent)) return second;
	return { ...first, content: [...firstContent, ...secondContent] } as Message;
}
