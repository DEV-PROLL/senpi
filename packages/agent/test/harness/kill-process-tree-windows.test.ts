import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killWindowsProcessTree, resolveWindowsTaskkillPath } from "../../src/harness/env/nodejs.ts";

/** A name that can never resolve on PATH, so spawn() fails with ENOENT on every platform. */
const UNRESOLVABLE_TASKKILL = "senpi-nonexistent-taskkill-binary.exe";

const tempRoots: string[] = [];

function createFakeSystemRoot(withTaskkill: boolean): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-systemroot-"));
	tempRoots.push(root);
	if (withTaskkill) {
		mkdirSync(join(root, "System32"), { recursive: true });
		writeFileSync(join(root, "System32", "taskkill.exe"), "");
	}
	return root;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

describe("resolveWindowsTaskkillPath", () => {
	it("prefers the absolute System32 executable over a bare PATH lookup", () => {
		const root = createFakeSystemRoot(true);
		expect(resolveWindowsTaskkillPath({ SystemRoot: root })).toBe(join(root, "System32", "taskkill.exe"));
	});

	it("falls back to the bare executable name when System32 has no taskkill", () => {
		const root = createFakeSystemRoot(false);
		expect(resolveWindowsTaskkillPath({ SystemRoot: root })).toBe("taskkill.exe");
		expect(resolveWindowsTaskkillPath({})).toBe("taskkill.exe");
	});
});

describe("killWindowsProcessTree", () => {
	it("kills the child instead of crashing the process when taskkill cannot be spawned", async () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
		await once(child, "spawn");
		const pid = child.pid;
		expect(pid).toBeDefined();

		const uncaught: unknown[] = [];
		const onUncaught = (error: unknown) => uncaught.push(error);
		process.on("uncaughtException", onUncaught);

		try {
			// spawn() surfaces ENOENT asynchronously through the child's 'error' event.
			// Before the fix this became an uncaughtException that killed the host process.
			killWindowsProcessTree(pid as number, UNRESOLVABLE_TASKKILL);
			await once(child, "exit");
			expect(uncaught).toEqual([]);
		} finally {
			process.off("uncaughtException", onUncaught);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
	});
});
