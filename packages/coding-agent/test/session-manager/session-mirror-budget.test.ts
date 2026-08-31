import type { TextContent } from "@earendil-works/pi-ai";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResidentStringStore } from "../../src/core/session-resident-store.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const LARGE_TEXT = "x".repeat(1024 * 1024);
const LARGE_PAYLOAD: TextContent[] = [{ type: "text", text: LARGE_TEXT }];

describe("SessionManager resident mirror", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-mirror-budget-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps the resident blob cache within its documented budget", () => {
		const session = SessionManager.create(tempDir, tempDir);
		for (let i = 0; i < 70; i++) {
			session.appendCustomEntry("large-result", { payload: `${i}:${LARGE_TEXT}` });
		}

		expect(session.getResidentStoreStats().blobBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
	});

	it("trims pre-compaction mirror entries but reloads them for branching", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage({ role: "assistant", content: [{ type: "text", text: "ready" }], timestamp: 0 });
		const prunedEntryId = session.appendMessage({ role: "user", content: LARGE_PAYLOAD, timestamp: 1 });
		const firstKeptEntryId = session.appendMessage({ role: "user", content: LARGE_PAYLOAD, timestamp: 2 });
		session.appendMessage({ role: "user", content: LARGE_PAYLOAD, timestamp: 3 });
		const beforeBlobBytes = session.getResidentStoreStats().blobBytes;

		session.appendCompaction("summary", firstKeptEntryId, 100);

		expect(session.getEntries()).toHaveLength(5);
		expect(session.getResidentStoreStats().blobBytes).toBeLessThan(beforeBlobBytes);

		session.branch(prunedEntryId);
		expect(session.getEntry(prunedEntryId)?.id).toBe(prunedEntryId);
		expect(session.buildSessionContext().messages).toHaveLength(2);
	});

	it("bounds standalone resident stores too", () => {
		const store = new ResidentStringStore();
		for (let i = 0; i < 70; i++) store.externalize(`${i}:${LARGE_TEXT}`);
		expect(store.stats().blobBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
	});
});
