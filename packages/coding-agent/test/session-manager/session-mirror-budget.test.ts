import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResidentStringStore } from "../../src/core/session-resident-store.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const LARGE_PAYLOAD = "x".repeat(1024 * 1024);

describe("SessionManager resident mirror", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-mirror-budget-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("currently retains every large externalized blob appended to a session", () => {
		const session = SessionManager.create(tempDir, tempDir);
		for (let i = 0; i < 70; i++) {
			session.appendCustomEntry("large-result", { payload: `${i}:${LARGE_PAYLOAD}` });
		}

		expect(session.getResidentStoreStats().blobBytes).toBeGreaterThan(64 * 1024 * 1024);
	});

	it("currently leaves the complete mirror unchanged by compaction", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const firstKeptEntryId = session.appendCustomEntry("before-compaction", { payload: LARGE_PAYLOAD });
		session.appendCustomEntry("before-compaction", { payload: LARGE_PAYLOAD });
		const beforeLength = session.getEntries().length;
		const beforeBlobBytes = session.getResidentStoreStats().blobBytes;

		session.appendCompaction("summary", firstKeptEntryId, 100);

		expect(session.getEntries()).toHaveLength(beforeLength + 1);
		expect(session.getResidentStoreStats().blobBytes).toBe(beforeBlobBytes);
	});

	it("uses the resident store's current unbounded behavior as the regression baseline", () => {
		const store = new ResidentStringStore();
		for (let i = 0; i < 70; i++) store.externalize(`${i}:${LARGE_PAYLOAD}`);
		expect(store.stats().blobBytes).toBeGreaterThan(64 * 1024 * 1024);
	});
});
