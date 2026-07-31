import type { ExtensionAPI } from "../../types.ts";
import { closeSession, markTainted, recordBranchInfo } from "./session-registry.ts";

export function registerSessionRegistry(pi: Pick<ExtensionAPI, "on">): void {
	pi.on("session_compact", (_event, ctx) => {
		markTainted(ctx.sessionManager.getSessionId(), "compaction");
	});
	pi.on("session_before_fork", (_event, ctx) => {
		markTainted(ctx.sessionManager.getSessionId(), "fork");
	});
	pi.on("session_tree", (event, ctx) => {
		if (event.oldLeafId === null || event.newLeafId === null) return;
		recordBranchInfo(ctx.sessionManager.getSessionId(), {
			oldLeafId: event.oldLeafId,
			newLeafId: event.newLeafId,
		});
	});
	pi.on("session_shutdown", (event, ctx) => {
		closeSession(ctx.sessionManager.getSessionId(), event.reason);
	});
	pi.on("session_extensions_removed", (_event, ctx) => {
		closeSession(ctx.sessionManager.getSessionId(), "extensions_removed");
	});
}
