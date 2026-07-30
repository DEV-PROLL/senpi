import { Box, Text } from "@earendil-works/pi-tui";
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

const BOLD = "\u001b[1m";
const BOLD_OFF = "\u001b[22m";

export const renderGoalCacheWarmupEntry: EntryRenderer<GoalCacheWarmupEntryData> = (entry, options, theme) => {
	const data = entry.data;
	if (data === undefined) return undefined;
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("accent", `${BOLD}${titleLine(data)}${BOLD_OFF}`), 0, 0));
	box.addChild(new Text(theme.fg("dim", whyLine(data)), 0, 0));
	const warm = warmLine(data.phase, data.cache);
	if (warm !== undefined) box.addChild(new Text(theme.fg("success", warm), 0, 0));
	if (options.expanded) {
		box.addChild(
			new Text(theme.fg("dim", `goal ${data.goalId} · planned delay ${formatWakeDuration(data.delayMs)}`), 0, 0),
		);
	}
	return box;
};

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
