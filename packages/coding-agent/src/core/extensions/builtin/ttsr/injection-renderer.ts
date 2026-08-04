import { noticeEntryRenderer } from "../../notice/index.ts";
import type { EntryRenderer } from "../../types.ts";
import type { TtsrInjectionRecord } from "./types.ts";

export const renderTtsrInjectionEntry: EntryRenderer<TtsrInjectionRecord> = noticeEntryRenderer((entry) => {
	const record = entry.data;
	if (record === undefined) return undefined;
	return {
		title: `⚠ Stream rule · ${record.owner}`,
		tone: "warning",
		why: whyLine(record.remediation),
		expandedLine: `rules ${record.rules.join(", ")} · remediation ${record.remediation} · ${new Date(record.at).toISOString()}`,
	};
});

function whyLine(remediation: TtsrInjectionRecord["remediation"]): string {
	switch (remediation) {
		case "nudge":
			return "Output was cut at the anomaly and removed from context; the agent was nudged to continue.";
		case "provider-error":
			return "The response was discarded as a provider error and resampled through the retry path.";
	}
}
