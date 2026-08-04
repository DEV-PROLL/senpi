import type { CustomMessage } from "../../messages.ts";
import type { CustomEntry } from "../../session-manager.ts";
import type { EntryRenderer, MessageRenderer } from "../types.ts";
import { buildNoticeBox } from "./box.ts";
import type { NoticeSpec } from "./spec.ts";

/**
 * Adapt a NoticeSpec mapper into a MessageRenderer for custom messages
 * (model-facing notices such as loop-guard detections).
 */
export function noticeMessageRenderer<T>(
	map: (message: CustomMessage<T>) => NoticeSpec | undefined,
): MessageRenderer<T> {
	return (message, options, theme) => {
		const spec = map(message);
		return spec === undefined ? undefined : buildNoticeBox(spec, options, theme);
	};
}

/**
 * Adapt a NoticeSpec mapper into an EntryRenderer for durable custom entries
 * (display-only records such as ttsr injections; entries never reach the LLM).
 */
export function noticeEntryRenderer<T>(map: (entry: CustomEntry<T>) => NoticeSpec | undefined): EntryRenderer<T> {
	return (entry, options, theme) => {
		const spec = map(entry);
		return spec === undefined ? undefined : buildNoticeBox(spec, options, theme);
	};
}
