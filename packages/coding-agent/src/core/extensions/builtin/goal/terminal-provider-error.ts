import type { AgentEndEvent } from "../../types.ts";

export function didTerminalProviderErrorEndTurn(event: AgentEndEvent): boolean {
	if (event.willRetry !== false) return false;
	for (let index = event.messages.length - 1; index >= 0; index--) {
		const message = event.messages[index];
		if (message?.role !== "assistant") continue;
		return message.stopReason === "error" || (message.stopReason === "aborted" && event.abortSource === undefined);
	}
	return false;
}
