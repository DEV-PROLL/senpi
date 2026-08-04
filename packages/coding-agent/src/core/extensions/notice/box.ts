import { Box, type Component, Text } from "@earendil-works/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { NoticeSpec } from "./spec.ts";

const BOLD = "[1m";
const BOLD_OFF = "[22m";

/** Render a NoticeSpec as the shared transcript notice box (loop-guard visual family). */
export function buildNoticeBox(spec: NoticeSpec, options: { readonly expanded: boolean }, theme: Theme): Component {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg(spec.tone ?? "accent", `${BOLD}${spec.title}${BOLD_OFF}`), 0, 0));
	box.addChild(new Text(theme.fg("dim", spec.why), 0, 0));
	for (const line of spec.extra ?? []) {
		box.addChild(new Text(theme.fg(line.tone ?? "dim", line.text), 0, 0));
	}
	if (options.expanded && spec.expandedLine !== undefined) {
		box.addChild(new Text(theme.fg("dim", spec.expandedLine), 0, 0));
	}
	return box;
}
