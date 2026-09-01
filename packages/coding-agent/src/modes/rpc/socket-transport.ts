import { createHash } from "node:crypto";

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\senpi-rpc-";

export function resolveSocketTransportAddress(socketPath: string, platform: NodeJS.Platform): string {
	if (platform !== "win32") return socketPath;
	const name = createHash("sha256").update(socketPath, "utf8").digest("hex").slice(0, 32);
	return `${WINDOWS_PIPE_PREFIX}${name}`;
}
