import { Box, Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../types.ts";
import type { LoopGuardDetection } from "./detectors.ts";

const BOLD = "\u001b[1m";
const BOLD_OFF = "\u001b[22m";

export const renderLoopGuardNotice: MessageRenderer<LoopGuardDetection> = (message, options, theme) => {
	const details = message.details;
	if (details === undefined) return undefined;
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("accent", `${BOLD}${titleLine(details)}${BOLD_OFF}`), 0, 0));
	box.addChild(new Text(theme.fg("dim", whyLine(details)), 0, 0));
	if (options.expanded) {
		box.addChild(new Text(theme.fg("dim", expandedLine(details)), 0, 0));
	}
	return box;
};

function titleLine(detection: LoopGuardDetection): string {
	switch (detection.kind) {
		case "identical":
			return `⚠ Loop guard · identical calls ×${detection.count} (${detection.toolName})`;
		case "similar":
			return `⚠ Loop guard · near-identical calls ×${detection.count} (${detection.toolName})`;
		case "cycle":
			return `⚠ Loop guard · repeating pattern ×${detection.count} (period ${detection.period})`;
	}
}

function whyLine(detection: LoopGuardDetection): string {
	switch (detection.kind) {
		case "identical":
			return "Same tool, same arguments, again. The agent was told to reuse the result or change the call.";
		case "similar": {
			const percent = Math.round(detection.similarity * 100);
			return `Argument similarity ~${percent}%. The agent was told to verify this is distinct work, not a lazy loop.`;
		}
		case "cycle": {
			const pattern = detection.cycleTools.join(" -> ");
			return `Tool-call cycle [${pattern}]. The agent was told to break the rotation or justify the progress.`;
		}
	}
}

function expandedLine(detection: LoopGuardDetection): string {
	switch (detection.kind) {
		case "identical":
			return `tool ${detection.toolName} · ${detection.count} consecutive identical calls when the reminder fired`;
		case "similar":
			return `tool ${detection.toolName} · ${detection.count} consecutive same-tool calls at ~${Math.round(detection.similarity * 100)}% args similarity`;
		case "cycle":
			return `cycle ${detection.cycleTools.join(" -> ")} · ${detection.count} full repetitions in the tracked window`;
	}
}
