import * as fs from "fs";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResidentStringStore } from "../../src/core/session-resident-store.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const LARGE_TEXT = "x".repeat(1024 * 1024);

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
		session.appendMessage(assistantMsg("ready"));
		const prunedEntryId = session.appendMessage(userMsg(LARGE_TEXT));
		const firstKeptEntryId = session.appendMessage(userMsg(LARGE_TEXT));
		session.appendMessage(userMsg(LARGE_TEXT));
		const beforeBlobBytes = session.getResidentStoreStats().blobBytes;

		session.appendCompaction("summary", firstKeptEntryId, 100);

		expect(session.getEntries()).toHaveLength(5);
		expect(session.getResidentStoreStats().blobBytes).toBeLessThan(beforeBlobBytes);

		session.branch(prunedEntryId);
		expect(session.getEntry(prunedEntryId)?.id).toBe(prunedEntryId);
		expect(session.buildSessionContext().messages).toHaveLength(2);
	});

	it("loads trimmed full history once for consecutive reads", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantMsg("ready"));
		const firstKeptEntryId = session.appendMessage(userMsg("before"));
		session.appendMessage(assistantMsg("after"));
		session.appendCompaction("summary", firstKeptEntryId, 100);

		const openSpy = vi.spyOn(fs, "openSync").mockClear();
		try {
			session.getEntries();
			session.getEntries();
			expect(openSpy.mock.calls.filter(([path]) => path === session.getSessionFile()).length).toBe(1);
		} finally {
			openSpy.mockRestore();
		}
	});

	it("bounds standalone resident stores too", () => {
		const store = new ResidentStringStore();
		for (let i = 0; i < 70; i++) store.externalize(`${i}:${LARGE_TEXT}`);
		expect(store.stats().blobBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
	});
});
