import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { resolveAutoTitleSessions } from "../src/main.ts";
import { waitForSessionName } from "./agent-session-auto-title-helpers.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * `--auto-title-sessions` opts non-interactive app modes (notably `--mode rpc`,
 * with or without `--multi-session`) into engine-side session auto-titling.
 * Interactive launches keep auto-titling on by default, and a resumed session
 * that already carries context messages must never be retitled.
 */
describe("resolveAutoTitleSessions", () => {
	test("keeps auto-titling on for interactive launches without the flag", () => {
		const parsed = parseArgs([]);
		expect(resolveAutoTitleSessions("interactive", parsed, false)).toBe(true);
	});

	test("leaves non-interactive modes off without the flag", () => {
		const parsed = parseArgs(["--mode", "rpc", "--multi-session"]);
		expect(resolveAutoTitleSessions("rpc", parsed, false)).toBe(false);
	});

	test.each(["rpc", "print", "json", "app-server"] as const)("honors the flag in %s mode", (appMode) => {
		const parsed = parseArgs(["--mode", "rpc", "--multi-session", "--auto-title-sessions"]);
		expect(resolveAutoTitleSessions(appMode, parsed, false)).toBe(true);
	});

	test("still suppresses auto-titling when the session has context messages", () => {
		const parsed = parseArgs(["--mode", "rpc", "--multi-session", "--auto-title-sessions"]);
		expect(resolveAutoTitleSessions("rpc", parsed, true)).toBe(false);
	});

	test("suppresses auto-titling for interactive resumes with context messages", () => {
		const parsed = parseArgs([]);
		expect(resolveAutoTitleSessions("interactive", parsed, true)).toBe(false);
	});
});

describe("rpc sessions launched with --auto-title-sessions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	test("titles a fresh rpc session", async () => {
		const parsed = parseArgs(["--mode", "rpc", "--multi-session", "--auto-title-sessions"]);
		const harness = await createHarness({
			persistSession: true,
			autoTitleSessions: resolveAutoTitleSessions("rpc", parsed, false),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("turn complete"),
			fauxAssistantMessage("<title>RPC Titled Session</title>"),
		]);

		const sessionName = waitForSessionName(harness);
		await harness.session.prompt("fix the OAuth login button on mobile");

		await expect(sessionName).resolves.toBe("RPC Titled Session");
	});

	test("leaves a resumed rpc session with context messages untitled", async () => {
		const parsed = parseArgs(["--mode", "rpc", "--multi-session", "--auto-title-sessions"]);
		const harness = await createHarness({
			persistSession: true,
			autoTitleSessions: resolveAutoTitleSessions("rpc", parsed, true),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("turn complete")]);

		await harness.session.prompt("fix the OAuth login button on mobile");
		await harness.session.waitForSettledSessionWork();

		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});
});
