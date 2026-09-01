import { createHash } from "node:crypto";
import { win32 } from "node:path";

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\senpi-rpc-";
export function resolveSocketTransportAddress(socketPath: string, platform: NodeJS.Platform): string {
	if (platform !== "win32" || socketPath.toLowerCase().startsWith("\\\\.\\pipe\\")) return socketPath;
	// Windows paths are case-insensitive and accept both slash styles. Resolve
	// them with win32 semantics even when this helper is unit-tested on POSIX.
	const canonical = win32.normalize(win32.resolve(socketPath)).toLowerCase();
	const name = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
	return `${WINDOWS_PIPE_PREFIX}${name}`;
}
