import type { RpcSessionEntry } from "./session-registry.ts";
import { RpcSessionRegistryError } from "./session-registry.ts";

export interface SessionTeardownHost {
	get(handle: string): RpcSessionEntry | undefined;
	delete(handle: string): void;
	releaseReservation(key: string): void;
	sync(): void;
}

export function beginSessionClose(host: SessionTeardownHost, handle: string): RpcSessionEntry {
	const entry = host.get(handle);
	if (entry?.state !== "open") throw new RpcSessionRegistryError("unknown_session");
	entry.attachments -= 1;
	if (entry.attachments > 0) return entry;
	entry.state = "closing";
	return entry;
}

export async function closeSession(host: SessionTeardownHost, handle: string): Promise<void> {
	const entry = beginSessionClose(host, handle);
	if (entry.state !== "closing") return;
	return closeMarkedSession(host, handle);
}

export async function closeMarkedSession(host: SessionTeardownHost, handle: string): Promise<void> {
	host.sync();
	const entry = host.get(handle);
	if (entry?.state !== "closing") throw new RpcSessionRegistryError("unknown_session");
	const previousLifecycle = entry.lifecycleMutex;
	entry.lifecycleMutex = (async () => {
		await previousLifecycle;
		try {
			await entry.runtime?.session.abort();
			await entry.runtime?.session.waitForIdle();
			await entry.runtime?.dispose();
			await entry.scope.close?.();
		} finally {
			entry.state = "closed";
			host.delete(handle);
			if (entry.reservationKey) host.releaseReservation(entry.reservationKey);
		}
	})();
	return entry.lifecycleMutex;
}
