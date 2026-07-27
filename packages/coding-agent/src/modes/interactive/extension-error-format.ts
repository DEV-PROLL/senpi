import { RUNTIME_EXTENSION_PATH } from "../../core/extensions/types.ts";

/**
 * Strip terminal control sequences from text that reaches an ANSI-preserving
 * chat row. Error text can carry provider-controlled bytes — a JSON error body
 * may decode `\u001b` escapes into live OSC/CSI sequences — so anything routed
 * to `Text` is sanitized first.
 */
export function sanitizeTuiErrorMessage(value: string): string {
	return value
		.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g, "")
		.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
		.replace(/[ \t\f\v]+/g, " ");
}

/**
 * Headline for an extension-error line in the chat log.
 *
 * Errors emitted by the session runtime itself (extensionPath `<runtime>`,
 * e.g. background session-title generation) are not extension failures, so
 * they render as runtime errors labeled with the emitting event instead of a
 * confusing `Extension "<runtime>" error:` attribution.
 */
export function formatExtensionErrorHeadline(error: {
	readonly extensionPath: string;
	readonly event?: string;
	readonly error: string;
}): string {
	const message = sanitizeTuiErrorMessage(error.error);
	if (error.extensionPath === RUNTIME_EXTENSION_PATH) {
		const event = error.event ? sanitizeTuiErrorMessage(error.event) : undefined;
		return event ? `Runtime error (${event}): ${message}` : `Runtime error: ${message}`;
	}
	return `Extension "${sanitizeTuiErrorMessage(error.extensionPath)}" error: ${message}`;
}
