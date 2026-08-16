export const MAX_RPC_MESSAGE_CHARACTERS = 1_000_000;

interface RpcMessageInput {
	type?: unknown;
	message?: unknown;
}

export function rpcMessageLengthError(command: RpcMessageInput): string | undefined {
	if (command.type !== "prompt" && command.type !== "steer" && command.type !== "follow_up") {
		return undefined;
	}
	if (typeof command.message !== "string" || command.message.length <= MAX_RPC_MESSAGE_CHARACTERS) {
		return undefined;
	}
	return `RPC ${command.type} message exceeds ${MAX_RPC_MESSAGE_CHARACTERS} characters.`;
}
