import { bindToProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import type { ExtensionAPI, ExtensionFactory } from "../../types.ts";
import { getToolSearchService, installScopedToolSearchService, ToolSearchService } from "./service.ts";
import { createToolSearchTool } from "./tool.ts";

export function createToolSearchExtension(service: ToolSearchService): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		service.bindRuntime(pi);

		pi.on("session_start", (_event, ctx) => {
			service.beginSession();
			service.maybeRehydrateFromHistory(ctx.sessionManager.getEntries());
		});
		pi.on("context", (event) => {
			service.maybeRehydrateFromHistory(event.messages);
		});
		pi.registerLazyToolActivator((toolName) => service.activateTool(toolName));
		pi.registerTool(createToolSearchTool(service));
	};
}

function hasProviderScope(): boolean {
	try {
		bindToProviderScope(() => undefined);
		return true;
	} catch {
		return false;
	}
}

export default function toolSearchExtension(pi: ExtensionAPI): void | Promise<void> {
	const runtime = {
		getAllTools: () => pi.getAllTools(),
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (names: readonly string[]) => pi.setActiveTools([...names]),
	};
	const sessionOwned = hasProviderScope();
	const service = sessionOwned ? new ToolSearchService(runtime) : getToolSearchService(runtime);
	if (sessionOwned) installScopedToolSearchService(service);
	return createToolSearchExtension(service)(pi);
}

export { getToolSearchService, ToolSearchService } from "./service.ts";
export { createToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "./tool.ts";
