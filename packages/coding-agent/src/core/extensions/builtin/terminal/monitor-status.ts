import type { MonitorSnapshotEntry } from "./monitor-registry.ts";

export const MONITOR_STATUS_KEY = "monitors";

/** The footer shares one status line with other extensions; keep this brief. */
const MAX_STATUS_LENGTH = 48;
/** Marks the status as a live watch at a glance (same glyph family as the session selector). */
const WATCH_GLYPH = "◉";

function truncateEnd(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Fits as many whole descriptions as possible into the budget, folding the rest
 * into a `+N more` counter so the monitor count is never truncated away.
 */
function packDescriptions(names: readonly string[], budget: number): string {
	for (let kept = names.length; kept >= 1; kept--) {
		const hiddenCount = names.length - kept;
		const tail = hiddenCount > 0 ? ` +${hiddenCount} more` : "";
		const joined = names.slice(0, kept).join(", ");
		if (joined.length + tail.length <= budget) return joined + tail;
	}
	const tail = names.length > 1 ? ` +${names.length - 1} more` : "";
	return truncateEnd(names[0] ?? "", Math.max(1, budget - tail.length)) + tail;
}

/** Brief footer text for the active monitors; undefined clears the status. */
export function formatMonitorStatus(snapshot: readonly MonitorSnapshotEntry[]): string | undefined {
	if (snapshot.length === 0) return undefined;
	const pausedCount = snapshot.filter((entry) => entry.paused).length;
	const suffix = pausedCount === 0 ? "" : pausedCount === snapshot.length ? " (paused)" : ` (${pausedCount} paused)`;
	if (snapshot.length === 1) {
		const head = `${WATCH_GLYPH} watching `;
		const description = truncateEnd(snapshot[0]?.description ?? "", MAX_STATUS_LENGTH - head.length - suffix.length);
		return head + description + suffix;
	}
	const head = `${WATCH_GLYPH} watching ${snapshot.length}: `;
	const names = snapshot.map((entry) => entry.description);
	return head + packDescriptions(names, MAX_STATUS_LENGTH - head.length - suffix.length) + suffix;
}
