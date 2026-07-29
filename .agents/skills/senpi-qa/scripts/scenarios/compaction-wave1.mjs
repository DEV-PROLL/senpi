#!/usr/bin/env node
/**
 * Compaction-wave1 QA scenario.
 *
 * Drives the real senpi CLI from source in an isolated sandbox, feeds a scripted
 * compaction turn, and asserts the compaction artifacts emitted by the session,
 * logs, and stderr mirror.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	runCli,
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { API_PRESETS, hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";

const COMPACTION_REQUEST = `${"Fill context to force compaction. ".repeat(220)}<task-intent>ORIGINAL_REQUEST: TASK_TYPE: implementation MUST_PRESERVE: files MUST_NOT_LOSE: nothing</task-intent><summary>${"compaction seed ".repeat(120)}</summary>`;
const FINAL_TURN_TEXT = "COMPACTION-WAVE1-FINAL-TURN-7f3a";
const MIRROR_NEEDLE = "[senpi-compaction]";

function readMaybe(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function findJsonlPath(root) {
	if (!root) return null;
	try {
		readdirSync(root, { withFileTypes: true });
	} catch {
		return null;
	}
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop();
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) return full;
		}
	}
	return null;
}

function parseJsonl(text) {
	return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function assertArtifacts(checks, { sessionJsonlPath, compactionLogPath, stderr, expectMirror }) {
	const sessionLines = sessionJsonlPath ? parseJsonl(readFileSync(sessionJsonlPath, "utf8")) : [];
	const compactionEntry = sessionLines.find((line) => line?.details?.origin === "speculative" && line?.details?.taskIntent);
	checks.ok("session JSONL contains a compaction entry with speculative origin and taskIntent", !!compactionEntry, compactionEntry ? JSON.stringify(compactionEntry.details ?? compactionEntry) : "missing");
	const logLines = readMaybe(compactionLogPath).trim().split(/\r?\n/).filter(Boolean);
	checks.ok("compaction.log contains >=1 JSONL decision line", logLines.length >= 1, `lines=${logLines.length}`);
	checks.ok("stderr contains a [senpi-compaction] mirror line", expectMirror ? stderr.includes(MIRROR_NEEDLE) : !stderr.includes(MIRROR_NEEDLE), `mirror=${stderr.includes(MIRROR_NEEDLE)}`);
}

async function runScenario({ debug = true, fixtureOnly = false } = {}) {
	installCleanupHooks();
	const checks = createChecks(fixtureOnly ? "compaction-wave1.mjs --self-test" : "compaction-wave1.mjs");
	const guard = guardRealAuth();
	const box = makeSandbox("compaction-wave1");
	let server = null;
	let result = { code: 0, stdout: "", stderr: "", timedOut: false };
	try {
		server = await startFakeModelServer({ turns: [{ text: COMPACTION_REQUEST }, { text: FINAL_TURN_TEXT }] });
		const preset = API_PRESETS["openai-completions"];
		writeMockModelsJson(box.agentDir, server, "openai-completions", { contextWindow: 4096 });
		mkdirSync(join(box.agentDir, "logs"), { recursive: true });
		const env = hermeticEnv(box.env);
		if (debug) env.SENPI_COMPACTION_DEBUG = "1";
		else delete env.SENPI_COMPACTION_DEBUG;
		result = await runCli(["--provider", preset.provider, "--model", preset.modelId, "--no-context-files", "--print", COMPACTION_REQUEST], { env, cwd: box.cwd, timeoutMs: 120000 });
		const sessionRoot = join(box.agentDir, "sessions");
		const sessionJsonlPath = findJsonlPath(sessionRoot) || findJsonlPath(box.sessionDir);
		const compactionLogPath = join(box.agentDir, "logs", "compaction.log");
		assertArtifacts(checks, { sessionJsonlPath, compactionLogPath, stderr: result.stderr, expectMirror: debug });
		checks.ok("CLI exited cleanly", result.code === 0 && !result.timedOut, `code=${result.code} timedOut=${result.timedOut}`);
		checks.ok("fake model was called twice", server.requests.length === 2, `requests=${server.requests.length}`);
		if (result.code !== 0 || result.timedOut) process.stderr.write(`\n--- stderr tail ---\n${result.stderr.slice(-1500)}\n`);
		process.exit(checks.finish() ? 0 : 1);
	} finally {
		if (server) await server.stop();
		box.cleanup();
		guard.assertUnchanged();
	}
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
	runScenario({ preBaked: true }).catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exit(1);
	});
} else {
	runScenario({ debug: process.env.SENPI_COMPACTION_DEBUG === "1" }).catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exit(1);
	});
}
