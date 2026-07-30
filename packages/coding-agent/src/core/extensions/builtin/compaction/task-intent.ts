const TASK_INTENT_OPEN = "<task-intent>";
const TASK_INTENT_CLOSE = "</task-intent>";
const SUMMARY_OPEN = "<summary>";
const SUMMARY_CLOSE = "</summary>";
const TASK_INTENT_BYTE_CAP = 4096;
const REMOTE_SCHEMA = "senpi.compaction.openai-remote.v1";
const SUMMARY_SCHEMA = "senpi.compaction.summary.v1";

type BranchEntry = {
	schema?: string;
	details?: unknown;
};

type CompactionDetails = {
	taskIntent?: unknown;
};

export function extractTaskIntent(responseText: string): { taskIntent?: string; summaryText: string } {
	let taskIntent: string | undefined;
	let remaining = responseText;

	while (true) {
		const block = findWellFormedBlock(remaining, TASK_INTENT_OPEN, TASK_INTENT_CLOSE);
		if (!block) break;
		if (taskIntent === undefined) taskIntent = capUtf8Bytes(block.inner.trim(), TASK_INTENT_BYTE_CAP);
		remaining = `${remaining.slice(0, block.start)}${remaining.slice(block.end)}`;
	}

	const summaryBlocks = collectWellFormedBlocks(remaining, SUMMARY_OPEN, SUMMARY_CLOSE);
	const summaryText =
		summaryBlocks.length > 0
			? summaryBlocks
					.map((block) => block.inner.trim())
					.join("\n")
					.trim()
			: remaining.trim();

	return summaryText
		? { ...(taskIntent === undefined ? {} : { taskIntent }), summaryText }
		: { ...(taskIntent === undefined ? {} : { taskIntent }), summaryText: "" };
}

export function sanitizeTaskIntent(text: string): string {
	return text.split(TASK_INTENT_CLOSE).join("[/task-intent]");
}

export function resolveInheritedTaskIntent(branchEntries: BranchEntry[]): string | undefined {
	for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
		const entry = branchEntries[index];
		if (!entry || entry.schema === REMOTE_SCHEMA) continue;
		if (entry.schema !== SUMMARY_SCHEMA) continue;
		const details = entry.details;
		if (!details || typeof details !== "object" || Array.isArray(details)) continue;
		const taskIntent = (details as CompactionDetails).taskIntent;
		if (typeof taskIntent !== "string") continue;
		const trimmed = taskIntent.trim();
		if (!trimmed) continue;
		if (Buffer.byteLength(trimmed, "utf8") > TASK_INTENT_BYTE_CAP) continue;
		return trimmed;
	}
	return undefined;
}

function findWellFormedBlock(
	text: string,
	openTag: string,
	closeTag: string,
): { start: number; end: number; inner: string } | undefined {
	const start = text.indexOf(openTag);
	if (start < 0) return undefined;
	const end = text.indexOf(closeTag, start + openTag.length);
	if (end < 0) return undefined;
	return { start, end: end + closeTag.length, inner: text.slice(start + openTag.length, end) };
}

function collectWellFormedBlocks(
	text: string,
	openTag: string,
	closeTag: string,
): Array<{ start: number; end: number; inner: string }> {
	const blocks: Array<{ start: number; end: number; inner: string }> = [];
	let searchFrom = 0;
	while (searchFrom < text.length) {
		const start = text.indexOf(openTag, searchFrom);
		if (start < 0) break;
		const end = text.indexOf(closeTag, start + openTag.length);
		if (end < 0) break;
		blocks.push({ start, end: end + closeTag.length, inner: text.slice(start + openTag.length, end) });
		searchFrom = end + closeTag.length;
	}
	return blocks;
}

function capUtf8Bytes(text: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += char.length;
	}
	return text.slice(0, end).trim();
}
