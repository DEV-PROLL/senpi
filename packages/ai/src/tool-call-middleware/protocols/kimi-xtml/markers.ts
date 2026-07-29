export const XTML_TOOLS_OPEN = "<|open|>tools<|sep|>";
export const XTML_TOOLS_CLOSE = "<|close|>tools<|sep|>";
export const XTML_CALL_OPEN = "<|open|>call ";
export const XTML_CALL_CLOSE = "<|close|>call<|sep|>";
export const XTML_ARGUMENT_OPEN = "<|open|>argument ";
export const XTML_ARGUMENT_CLOSE = "<|close|>argument<|sep|>";
export const XTML_SEP = "<|sep|>";

const ATTRIBUTE_PATTERN = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<]+))/g;

export function parseXtmlAttributes(header: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (const match of header.matchAll(ATTRIBUTE_PATTERN)) {
		const key = match[1];
		if (!key) continue;
		attributes[key] = match[2] ?? match[3] ?? match[4] ?? "";
	}
	return attributes;
}

export function getPartialXtmlSuffix(text: string, tokens: readonly string[]): string {
	for (const token of tokens) {
		for (let length = token.length - 1; length > 0; length -= 1) {
			const prefix = token.slice(0, length);
			if (text.endsWith(prefix)) {
				return prefix;
			}
		}
	}
	return "";
}
