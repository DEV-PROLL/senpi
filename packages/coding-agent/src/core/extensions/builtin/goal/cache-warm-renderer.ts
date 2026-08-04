import { noticeEntryRenderer } from "../../notice/index.ts";
import type { EntryRenderer } from "../../types.ts";
import {
	formatCacheTtl,
	formatSavedUsd,
	formatWakeDuration,
	formatWarmTokenCount,
	type GoalCacheWarmMetrics,
	type GoalCacheWarmupEntryData,
	type GoalCacheWarmupPhase,
} from "./cache-warm.ts";

export const renderGoalCacheWarmupEntry: EntryRenderer<GoalCacheWarmupEntryData> = noticeEntryRenderer((entry) => {
	const data = entry.data;
	if (data === undefined) return undefined;
	const warm = warmLine(data.phase, data.cache);
	return {
		title: titleLine(data),
		why: whyLine(data),
		extra: warm === undefined ? [] : [{ text: warm, tone: "success" }],
		expandedLine: `goal ${data.goalId} · planned delay ${formatWakeDuration(data.delayMs)}`,
	};
});

function titleLine(data: GoalCacheWarmupEntryData): string {
	const monitors = data.activeMonitorCount === 1 ? "1 monitor on duty" : `${data.activeMonitorCount} monitors on duty`;
	switch (data.phase) {
		case "scheduled":
			return `⚡ Cache-warm wait · ${monitors}`;
		case "resumed":
			return `⚡ Cache-warm wake · waited ${formatWakeDuration(data.waitedMs ?? data.delayMs)} · ${monitors}`;
	}
}

function whyLine(data: GoalCacheWarmupEntryData): string {
	switch (data.phase) {
		case "scheduled": {
			const deferred = `Continuation deferred ${formatWakeDuration(data.delayMs)}`;
			return data.cache?.ttlSeconds !== undefined
				? `${deferred} - the timed wake stays inside the ${formatCacheTtl(data.cache.ttlSeconds)} prompt-cache TTL.`
				: `${deferred} - the monitor wakes the goal the moment decisive output lands.`;
		}
		case "resumed":
			return "Woke on schedule to keep pursuing the goal.";
	}
}

function warmLine(phase: GoalCacheWarmupPhase, cache: GoalCacheWarmMetrics | undefined): string | undefined {
	if (cache === undefined || cache.cachedTokens <= 0) return undefined;
	const tokens = `~${formatWarmTokenCount(cache.cachedTokens)} tokens`;
	const body = phase === "scheduled" ? `${tokens} kept warm` : `${tokens} stayed warm in the prompt cache`;
	const saved =
		cache.estimatedSavedUsd !== undefined && cache.estimatedSavedUsd > 0
			? ` · est. ${formatSavedUsd(cache.estimatedSavedUsd)} saved vs a cold re-read`
			: "";
	return `${body}${saved}`;
}
