const MAX_LISTED_TOOLS = 8;

function escapeXmlAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function availableToolGuidance(availableToolNames: readonly string[]): string {
	if (availableToolNames.length === 0) {
		return "To edit files, call only tools available in this request.";
	}
	const listed = availableToolNames.slice(0, MAX_LISTED_TOOLS).join(", ");
	const omitted = availableToolNames.length - MAX_LISTED_TOOLS;
	const suffix = omitted > 0 ? ` (and ${omitted} more)` : "";
	return `To edit files, call your own tools: ${listed}${suffix}.`;
}

export function demotedToolCallText(
	name: string,
	availableToolNames: readonly string[],
	firstOccurrence: boolean,
): string {
	const escapedName = escapeXmlAttribute(name);
	if (!firstOccurrence) return `<unavailable-tool-call name="${escapedName}"/>`;
	return [
		`<unavailable-tool-call name="${escapedName}">`,
		"Transcript record, not an action available to you. An earlier model in this session",
		`called "${escapedName}"; that tool does not exist for you and its input is omitted.`,
		availableToolGuidance(availableToolNames),
		"</unavailable-tool-call>",
	].join("\n");
}

export function demotedToolResultText(name: string, content: string): string {
	const escapedName = escapeXmlAttribute(name);
	const safeContent = content.replace(/<\/unavailable-tool-result/gi, (match) => `&lt;${match.slice(1)}`);
	return `<unavailable-tool-result name="${escapedName}">${safeContent}</unavailable-tool-result>`;
}
