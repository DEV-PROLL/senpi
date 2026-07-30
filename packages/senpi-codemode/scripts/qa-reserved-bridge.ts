import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import { createInterpreterDetector, getInterpreterAvailability } from "../src/interpreters/detect.ts";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";

class QaFailure extends Error {
	readonly name = "QaFailure";
}

function taskResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: { task_id: "st_qa", status: "completed" } };
}

const cell = [
	"solo = agent('summarize the diff', agent='explore')",
	"print('AGENT_SOLO=' + str(solo))",
	"fan = parallel([lambda: agent('unit one'), lambda: agent('unit two')])",
	"print('AGENT_PARALLEL=' + str(fan))",
	"print('SCHEMA_TOOLS=' + str(tool_schema()['tools']))",
	"print('OUTPUT=' + str(output('st_qa')))",
].join("\n");

async function main(): Promise<void> {
	const availability = await getInterpreterAvailability(defaultCodemodeSettings, createInterpreterDetector());
	if (!availability.py.detected.ok) throw new QaFailure("no python interpreter available");

	const dir = mkdtempSync(join(tmpdir(), "qa-reserved-"));
	const calls: string[] = [];
	const manager = await createCodemodeSessionManager({
		sessionId: "qa-reserved",
		cwd: dir,
		settings: defaultCodemodeSettings,
		availability,
		listTools: () => [{ name: "read", description: "read a file", parameters: { type: "object" } }],
		executeTool: Object.assign(
			async (toolName: string): Promise<AgentToolResult<unknown>> => {
				if (toolName.startsWith("__")) throw new QaFailure(`Unknown tool ${toolName}`);
				calls.push(toolName);
				return taskResult(toolName === "task" ? "DELEGATED" : "TRANSCRIPT");
			},
			{ isToolAvailable: (name: string) => name === "task" || name === "task_output" },
		),
		complete: async () => {
			throw new QaFailure("completion is not exercised");
		},
	});

	const lines: string[] = [];
	try {
		const kernel = await manager.getKernel("py", (message: KernelToHostMessage) => {
			if (message.type === "text") process.stdout.write(message.data);
			if (message.type === "text") lines.push(message.data);
		});
		const outcome = await kernel.run({ cellId: "qa-cell-1", code: cell, timeoutMs: 60_000 });
		if (!outcome.ok) throw new QaFailure("python cell failed");
	} finally {
		await manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}

	const transcript = lines.join("");
	for (const marker of ["AGENT_SOLO=DELEGATED", "SCHEMA_TOOLS=['read']", "OUTPUT=TRANSCRIPT"]) {
		if (!transcript.includes(marker)) throw new QaFailure(`missing expected marker: ${marker}`);
	}
	if (transcript.includes("Unknown tool")) throw new QaFailure("reserved tool name leaked to executeTool");
	console.log(`\nQA PASS — task calls: ${calls.filter((name) => name === "task").length}, tool names: ${[...new Set(calls)].join(",")}`);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
