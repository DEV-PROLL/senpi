import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const host = readFileSync(new URL("../src/modes/interactive/interactive-host-runtime.ts", import.meta.url), "utf8");
const mode = readFileSync(new URL("../src/modes/interactive/interactive-mode.ts", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/modes/rpc/rpc-client.ts", import.meta.url), "utf8");
const types = readFileSync(new URL("../src/modes/rpc/rpc-types.ts", import.meta.url), "utf8");
const handler = readFileSync(new URL("../src/modes/rpc/connection-handler.ts", import.meta.url), "utf8");

function contains(source: string, fragment: string): void {
	expect(source).toContain(fragment);
}

describe("shared-host parity regression pins", () => {
	it("R1 refreshes after new and fork replacement", () => {
		contains(host, "if (!result.cancelled) await this.#refreshAndRebind();");
		expect(host.match(/if \(!result\.cancelled\) await this\.#refreshAndRebind\(\);/g)).toHaveLength(4);
	});
	it("R2 routes tree navigation through RPC", () => {
		contains(host, 'if (property === "navigateTree")');
		contains(client, 'type: "navigate_tree"');
		contains(handler, 'case "navigate_tree"');
	});
	it("R3 routes JSONL import to the host replacement path", () => {
		contains(host, "client.importJsonl(inputPath, cwdOverride)");
		contains(client, 'type: "import_jsonl"');
		contains(types, 'type: "import_jsonl"');
		contains(handler, 'case "import_jsonl"');
		contains(handler, 'case "import_jsonl"');
	});
	it("R4 mirrors compaction and routes compaction abort", () => {
		contains(host, 'if (property === "isCompacting") return state.isCompacting;');
		contains(host, 'if (property === "abortCompaction") return () => void client.abortCompaction();');
		contains(handler, 'case "abort_compaction"');
	});
	it("R5 mirrors retry and bash lifecycle state", () => {
		contains(host, 'if (property === "retryAttempt") return state.retryAttempt;');
		contains(host, 'if (property === "isBashRunning") return state.isBashRunning;');
		contains(handler, "retryAttempt: session.retryAttempt");
	});
	it("R6 carries queue recovery ordering", () => {
		contains(client, 'await this.send({ type: "steer", message, images, enqueueOrder: recovery?.enqueueOrder });');
		contains(
			client,
			'await this.send({ type: "follow_up", message, images, enqueueOrder: recovery?.enqueueOrder });',
		);
		contains(handler, "enqueueOrder: command.enqueueOrder");
	});
	it("R7 carries bash options and live chunks", () => {
		contains(host, "bashChunk = onChunk;");
		contains(host, "options?.excludeFromContext");
		contains(handler, "excludeFromContext: command.excludeFromContext");
	});
	it("R8 reloads the current manager after compaction", () => {
		contains(host, "sessionManager.reloadFromDisk?.();");
		expect(host).not.toContain("local.sessionManager?.reloadFromDisk?.();");
	});
	it("R9 refreshes before the rebind callback", () => {
		contains(host, "await this.#remoteSession.refresh();\n\t\tawait this.#rebindSession?.();");
	});
	it("R10 routes runtime reload and JSONL export", () => {
		contains(host, 'if (property === "reload")');
		contains(host, 'if (property === "exportToJsonl")');
		contains(handler, 'case "export_jsonl"');
		contains(client, 'type: "export_jsonl"');
		contains(types, 'type: "export_jsonl"');
	});
	it("R11 preserves the system-prompt-change result", () => {
		contains(handler, "systemPromptName: systemPromptChange?.systemPromptName");
		contains(host, "systemPromptName: next.systemPromptName");
	});
	it("R12 awaits async command handlers", () => {
		contains(mode, "await this.showSettingsSelector();");
		contains(mode, "await this.showUserMessageSelector();");
		contains(mode, "await this.handleSessionCommand();");
	});
	it("R13 catches thinking-cycle RPC failures", () => {
		contains(mode, "this.cycleThinkingLevel().catch");
	});
	it("R14 awaits remote session-name writes", () => {
		contains(mode, "await this.session.setSessionName(name);");
	});
	it("public RpcClient.prompt retains the image-array overload", () => {
		contains(client, "async prompt(message: string, images?: ImageContent[]): Promise<void>;");
		contains(client, "Array.isArray(optionsOrImages)");
	});
});
