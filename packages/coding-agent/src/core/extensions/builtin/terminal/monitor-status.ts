import type { MonitorSnapshotEntry } from "./monitor-registry.ts";

export const MONITOR_STATUS_KEY = "monitors";

/** The footer shares one status line with other extensions; keep this brief. */
const MAX_STATUS_LENGTH = 48;

function truncateEnd(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Brief footer text for the active monitors; undefined clears the status. */
export function formatMonitorStatus(snapshot: readonly MonitorSnapshotEntry[]): string | undefined {
	if (snapshot.length === 0) return undefined;
	const pausedCount = snapshot.filter((entry) => entry.paused).length;
	const suffix = pausedCount === 0 ? "" : pausedCount === snapshot.length ? " (paused)" : ` (${pausedCount} paused)`;
	const names = snapshot.map((entry) => entry.description).join(", ");
	const head = snapshot.length === 1 ? `watching ${names}` : `watching ${snapshot.length}: ${names}`;
	return truncateEnd(head, MAX_STATUS_LENGTH - suffix.length) + suffix;
}
