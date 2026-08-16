import type { SourceInfo } from "../../core/source-info.ts";
import type { RpcSlashCommand } from "./rpc-command-surface.ts";

export interface RpcCommandInvocationEvent {
	type: "command_invocation";
	command: {
		name: string;
		source: "extension" | "prompt";
		sourceInfo: SourceInfo;
		syntax: "slash";
	};
}

export function detectRpcCommandInvocation(
	message: string,
	commands: readonly RpcSlashCommand[],
): RpcCommandInvocationEvent | undefined {
	const match = /^\/([^\s]+)(?:\s|$)/.exec(message);
	if (!match) return undefined;

	const command = commands.find((candidate) => candidate.name === match[1] && candidate.source !== "skill");
	if (!command || command.source === "skill") return undefined;

	return {
		type: "command_invocation",
		command: {
			name: command.name,
			source: command.source,
			sourceInfo: command.sourceInfo,
			syntax: "slash",
		},
	};
}
