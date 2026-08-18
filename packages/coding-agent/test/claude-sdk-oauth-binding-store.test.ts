import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StoredBinding } from "../src/core/extensions/builtin/claude-sdk-oauth/session-binding-store.ts";
import {
	bindingSidecarPath,
	deleteStoredBinding,
	readStoredBinding,
	writeStoredBinding,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-binding-store.ts";

const makeSessionFixture = (): { readonly dir: string; readonly sessionFile: string } => {
	const dir = mkdtempSync(join(tmpdir(), "binding-store-"));
	const sessionFile = join(dir, "session.json");
	writeFileSync(sessionFile, "{}", "utf8");
	return { dir, sessionFile };
};

function record(sessionFile: string, overrides: Partial<StoredBinding> = {}): StoredBinding {
	return {
		schemaVersion: 1,
		sessionPath: sessionFile,
		sessionId: "sess-abc-123",
		markerEntryId: "marker-1",
		sdkSessionId: "sdk-1",
		sentCount: 1,
		sentPrefixHash: "1".repeat(64),
		assistantContentHash: "2".repeat(64),
		lastAssistantUuid: "assistant-1",
		accountName: "default",
		modelId: "claude-test",
		systemPromptHash: "3".repeat(64),
		toolsetHash: "4".repeat(64),
		...overrides,
	};
}

describe("claude-sdk-oauth session binding store", () => {
	it("round-trips a binding record and preserves session path and session id", async () => {
		const { sessionFile } = makeSessionFixture();
		const sidecar = bindingSidecarPath(sessionFile);

		await writeStoredBinding(sessionFile, record(sessionFile));
		const stored = await readStoredBinding(sessionFile);

		expect(typeof sidecar).toBe("string");
		expect(sidecar).not.toBe(sessionFile);
		expect(stored?.sessionPath).toBe(sessionFile);
		expect(stored?.sessionId).toBe("sess-abc-123");
	});

	it("rejects a malformed sidecar file", async () => {
		const { sessionFile } = makeSessionFixture();
		const sidecar = bindingSidecarPath(sessionFile);
		writeFileSync(sidecar, "not-valid-json", "utf8");

		await expect(readStoredBinding(sessionFile)).resolves.toBeUndefined();
	});

	it("rejects an oversized binding record", async () => {
		const { sessionFile } = makeSessionFixture();

		await expect(
			writeStoredBinding(sessionFile, record(sessionFile, { sessionId: "x".repeat(1024 * 1024) })),
		).rejects.toThrow();
	});

	it("replaces a previously stored record", async () => {
		const { sessionFile } = makeSessionFixture();
		await writeStoredBinding(sessionFile, record(sessionFile, { sessionId: "first" }));
		await writeStoredBinding(sessionFile, record(sessionFile, { sessionId: "second" }));

		const stored = await readStoredBinding(sessionFile);
		expect(stored?.sessionId).toBe("second");
	});

	it("deletes the stored binding", async () => {
		const { sessionFile } = makeSessionFixture();
		await writeStoredBinding(sessionFile, record(sessionFile, { sessionId: "to-delete" }));
		await deleteStoredBinding(sessionFile);

		await expect(readStoredBinding(sessionFile)).resolves.toBeUndefined();
	});

	it("creates the sidecar file with mode 0600", async () => {
		const { sessionFile } = makeSessionFixture();
		await writeStoredBinding(sessionFile, record(sessionFile, { sessionId: "mode-test" }));
		const sidecar = bindingSidecarPath(sessionFile);

		const mode = statSync(sidecar).mode & 0o777;
		expect(mode).toBe(0o600);
	});
});
