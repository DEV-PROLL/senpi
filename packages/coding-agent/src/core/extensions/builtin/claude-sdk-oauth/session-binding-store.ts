import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_RECORD_BYTES = 16 * 1024;

const storedBindingSchema = z.strictObject({
	schemaVersion: z.literal(1),
	sessionPath: z.string().min(1).max(4096),
	sessionId: z.string().min(1).max(256),
	markerEntryId: z.string().min(1).max(256),
	sdkSessionId: z.string().min(1).max(256),
	sentCount: z.number().int().nonnegative().safe(),
	sentPrefixHash: z.string().regex(SHA256_HEX),
	assistantContentHash: z.string().regex(SHA256_HEX),
	lastAssistantUuid: z.string().min(1).max(256).nullable(),
	accountName: z.string().min(1).max(256),
	modelId: z.string().min(1).max(256),
	systemPromptHash: z.string().regex(SHA256_HEX),
	toolsetHash: z.string().regex(SHA256_HEX),
});

export type StoredBinding = Readonly<z.infer<typeof storedBindingSchema>>;

export function bindingSidecarPath(sessionFile: string): string {
	return `${resolve(sessionFile)}.claude-sdk-oauth-binding.json`;
}

export async function readStoredBinding(sessionFile: string): Promise<StoredBinding | undefined> {
	const path = bindingSidecarPath(sessionFile);
	let metadata: Awaited<ReturnType<typeof stat>>;
	try {
		metadata = await stat(path);
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw error;
	}
	if (metadata.size > MAX_RECORD_BYTES) return undefined;

	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	const parsed = storedBindingSchema.safeParse(value);
	if (!parsed.success || parsed.data.sessionPath !== resolve(sessionFile)) return undefined;
	return parsed.data;
}

export async function writeStoredBinding(sessionFile: string, record: StoredBinding): Promise<void> {
	const sessionPath = resolve(sessionFile);
	const parsed = storedBindingSchema.parse(record);
	if (parsed.sessionPath !== sessionPath) {
		throw new StoredBindingPathError(sessionPath, parsed.sessionPath);
	}
	const serialized = `${JSON.stringify(parsed)}\n`;
	if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
		throw new StoredBindingSizeError(Buffer.byteLength(serialized), MAX_RECORD_BYTES);
	}

	const path = bindingSidecarPath(sessionPath);
	const temporaryPath = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, path);
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

export async function deleteStoredBinding(sessionFile: string): Promise<void> {
	await rm(bindingSidecarPath(sessionFile), { force: true });
}

class StoredBindingPathError extends Error {
	constructor(expected: string, actual: string) {
		super(`Stored binding path mismatch: expected ${expected}, received ${actual}`);
		this.name = "StoredBindingPathError";
	}
}

class StoredBindingSizeError extends Error {
	constructor(actual: number, maximum: number) {
		super(`Stored binding exceeds ${maximum} bytes: ${actual}`);
		this.name = "StoredBindingSizeError";
	}
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
