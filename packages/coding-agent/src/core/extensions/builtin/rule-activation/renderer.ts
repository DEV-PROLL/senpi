import { Box, Text } from "@earendil-works/pi-tui";
import type { EntryRenderer } from "../../types.ts";
import { parseRuleActivationDetails, type RuleActivationDetails } from "./types.ts";

const BOLD = "\u001b[1m";
const BOLD_OFF = "\u001b[22m";

export const renderRuleActivationEntry: EntryRenderer<unknown> = (entry, options, theme) => {
	const details = parseRuleActivationDetails(entry.data);
	if (details === undefined) return undefined;
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("accent", `${BOLD}${titleLine(details)}${BOLD_OFF}`), 0, 0));
	box.addChild(new Text(theme.fg("dim", summaryLine(details)), 0, 0));
	if (options.expanded) {
		box.addChild(new Text(theme.fg("dim", detailLine(details)), 0, 0));
	}
	return box;
};

function titleLine(details: RuleActivationDetails): string {
	switch (details.kind) {
		case "project-rules":
			return `● Project rules · ${details.targetPath}`;
		case "ttsr":
			return `⚠ Stream rule · ${details.owner}`;
	}
}

function summaryLine(details: RuleActivationDetails): string {
	switch (details.kind) {
		case "project-rules": {
			const noun = details.rules.length === 1 ? "instruction" : "instructions";
			return `${details.rules.length} ${noun} matched and injected for this tool result.`;
		}
		case "ttsr":
			return details.remediation === "nudge"
				? "Output interrupted; a corrective nudge was queued."
				: "Corrupted generation discarded; bounded provider retry started.";
	}
}

function detailLine(details: RuleActivationDetails): string {
	switch (details.kind) {
		case "project-rules":
			return details.rules.map((rule) => `rule ${rule}`).join("\n");
		case "ttsr":
			return `remediation ${details.remediation} · observed ${details.rules.join(", ")}`;
	}
}
