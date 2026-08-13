import type { SessionEntry } from "../../../session-manager.ts";

export interface WarmAnchorSnapshot {
	firstKeptEntryId: string;
	branchEntries?: readonly SessionEntry[];
}

function latestCompactionIndex(entries: readonly SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index].type === "compaction") return index;
	}
	return -1;
}

/**
 * A warm summary describes the entries before its cut point. Growth after that
 * cut - the idle wait notices, monitor state, and the user's next prompt - lands
 * in the kept suffix and leaves the summary accurate, so a monotonic message
 * revision cannot decide validity: it counts appends the summary never covered.
 * Validity is a property of the summarized prefix, which stays intact while the
 * anchor keeps its position and no newer compaction boundary has rewritten the
 * history behind it.
 */
export function isWarmSummaryAnchorValid(
	snapshot: WarmAnchorSnapshot,
	currentBranchEntries: readonly SessionEntry[],
): boolean {
	const snapshotEntries = snapshot.branchEntries;
	if (!snapshotEntries) return false;

	const anchorIndex = currentBranchEntries.findIndex((entry) => entry.id === snapshot.firstKeptEntryId);
	if (anchorIndex === -1) return false;

	const snapshotAnchorIndex = snapshotEntries.findIndex((entry) => entry.id === snapshot.firstKeptEntryId);
	if (snapshotAnchorIndex !== anchorIndex) return false;

	if (latestCompactionIndex(currentBranchEntries) !== latestCompactionIndex(snapshotEntries)) return false;

	for (let index = 0; index < anchorIndex; index++) {
		if (currentBranchEntries[index].id !== snapshotEntries[index].id) return false;
	}
	return true;
}
