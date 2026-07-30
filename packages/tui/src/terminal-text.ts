import { homedir } from "node:os";
import { isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImageDimensions } from "./terminal-image.ts";
import { getCapabilities } from "./terminal-image.ts";

const TERMINAL_ESCAPE_PATTERN =
	/(?:\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

export function sanitizeTerminalLabel(value: string): string {
	return value
		.replace(TERMINAL_ESCAPE_PATTERN, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const parts: string[] = [];
	if (filename) {
		const sanitizedFilename = sanitizeTerminalLabel(filename);
		const label = shortenHomePath(sanitizedFilename);
		parts.push(
			isAbsolute(sanitizedFilename) && getCapabilities().hyperlinks
				? hyperlinkFile(label, sanitizedFilename)
				: label,
		);
	}
	parts.push(`[${sanitizeTerminalLabel(mimeType)}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}

function shortenHomePath(filename: string): string {
	const home = homedir();
	if (!home || filename === home) return filename;
	const normalizedHome = home.endsWith(sep) ? home.slice(0, -1) : home;
	return filename.startsWith(`${normalizedHome}${sep}`) ? `~${filename.slice(normalizedHome.length)}` : filename;
}

function hyperlinkFile(label: string, filename: string): string {
	return `\x1b]8;;${pathToFileURL(filename).href}\x1b\\${label}\x1b]8;;\x1b\\`;
}
