import type { AssistantMessageEventStream } from "../../../types.ts";
import { AssistantMessageEventStream as AssistantMessageEventStreamImpl } from "../../../utils/event-stream.ts";
import { recoverKimiXtmlThinking } from "./thinking-recovery.ts";

export function wrapStreamWithKimiThinkingRecovery(
	innerStream: AssistantMessageEventStream,
): AssistantMessageEventStream {
	const outerStream = new AssistantMessageEventStreamImpl();

	void (async (): Promise<void> => {
		try {
			for await (const event of innerStream) {
				if (event.type === "done") {
					const message = recoverKimiXtmlThinking(event.message);
					outerStream.push({ type: "done", reason: event.reason, message });
					outerStream.end();
					return;
				}
				if (event.type === "error") {
					outerStream.push(event);
					outerStream.end();
					return;
				}
				outerStream.push(event);
			}
			outerStream.end(recoverKimiXtmlThinking(await innerStream.result()));
		} catch (error) {
			outerStream.fail(error);
		}
	})();

	return outerStream;
}
