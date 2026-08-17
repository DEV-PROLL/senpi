import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "./agent-session.ts";
import { createCursorExecBridge } from "./cursor-exec-bridge.ts";

type CursorBridgeAgent = Pick<Agent, "emitExternalEvent" | "signal">;

export function createSessionCursorExecBridge(
	sessionRef: { current?: AgentSession },
	getAgent: () => CursorBridgeAgent,
) {
	return createCursorExecBridge({
		getTool: (name) => sessionRef.current?.getRegisteredTool(name),
		preflightToolCall: async (event) => sessionRef.current?.extensionRunner.emitToolCall(event),
		emitEvent: (event: AgentEvent) => {
			void getAgent().emitExternalEvent(event);
		},
		getAbortSignal: () => getAgent().signal,
	});
}
