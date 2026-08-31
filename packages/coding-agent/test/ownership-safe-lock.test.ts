import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireOwnershipSafeLock, LegacyLockArtifactError } from "../src/modes/rpc/ownership-safe-lock.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
const childSource = `
  import { acquireOwnershipSafeLock } from ${JSON.stringify(new URL("../src/modes/rpc/ownership-safe-lock.ts", import.meta.url).href)};
  console.log("TRYING");
  const lock = await acquireOwnershipSafeLock(process.argv[1]);
  console.log("ACQUIRED");
  if (process.argv[2] === "block") {
    console.log("BLOCKED");
    const end = Date.now() + 2200;
    while (Date.now() < end) {}
    console.log("UNBLOCKED");
  }
  if (process.argv[2] === "hold") await new Promise((resolve) => process.stdin.once("data", resolve));
  await lock();
  console.log("RELEASED");
`;

afterEach(async () => {
	for (const childProcess of children.splice(0)) {
		if (childProcess.exitCode === null && childProcess.signalCode === null) {
			childProcess.kill("SIGKILL");
			await new Promise<void>((resolve) => childProcess.once("exit", () => resolve()));
		}
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("ownership-safe-lock", () => {
	it("uses the option shape, persists a regular file, and releases idempotently", async () => {
		const root = await scratch();
		const lockPath = join(root, "target.lock");
		const release = await acquireOwnershipSafeLock(lockPath, {
			retries: { retries: 2, minTimeout: 1, maxTimeout: 2 },
		});
		expect((await stat(lockPath)).isFile()).toBe(true);
		await release();
		await release();
		expect((await stat(lockPath)).isFile()).toBe(true);
	});

	it("rejects a legacy directory without touching it", async () => {
		const root = await scratch();
		const lockPath = join(root, "target.lock");
		await mkdir(lockPath);
		await writeFile(`${lockPath}/legacy`, "untouched");
		await expect(acquireOwnershipSafeLock(lockPath)).rejects.toThrow(LegacyLockArtifactError);
		await expect(acquireOwnershipSafeLock(lockPath)).rejects.toMatchObject({
			code: "ELEGACY_LOCK_ARTIFACT",
			lockPath,
		});
		expect((await stat(lockPath)).isDirectory()).toBe(true);
		expect(await readFile(`${lockPath}/legacy`, "utf8")).toBe("untouched");
	});

	it("serializes real children: the waiter acquires only after the holder releases", async () => {
		const root = await scratch();
		const lockPath = join(root, "target.lock");
		const events: string[] = [];
		const holder = tracked(lockPath, events, "holder", "hold");
		await holder.seen("ACQUIRED");
		const waiter = tracked(lockPath, events, "waiter");
		// The waiter is provably attempting acquisition before the holder is
		// told to release; ordering (not a fixed absence window) is the proof:
		// a non-exclusive mutant acquires before holder:RELEASED and fails the
		// index assertion below deterministically.
		await waiter.seen("TRYING");
		holder.child.stdin?.write("go\n");
		await holder.seen("RELEASED");
		await waiter.seen("ACQUIRED");
		expect(events.indexOf("waiter:ACQUIRED")).toBeGreaterThan(events.indexOf("holder:RELEASED"));
	});

	it("releases a killed holder and keeps a blocked event loop exclusive", async () => {
		const root = await scratch();
		const lockPath = join(root, "target.lock");
		const events: string[] = [];
		const holder = tracked(lockPath, events, "holder", "hold");
		await holder.seen("ACQUIRED");
		const waiter = tracked(lockPath, events, "waiter");
		await waiter.seen("TRYING");
		holder.child.kill("SIGKILL");
		await waiter.seen("ACQUIRED");

		const blocked = tracked(lockPath, events, "blocked", "block");
		const blockedAcquired = blocked.seen("ACQUIRED");
		waiter.child.kill("SIGKILL");
		await blockedAcquired;
		const lateWaiter = tracked(lockPath, events, "late");
		const lateAcquired = lateWaiter.seen("ACQUIRED");
		await lateWaiter.seen("TRYING");
		await blocked.seen("UNBLOCKED");
		await lateAcquired;
		expect(events.indexOf("late:ACQUIRED")).toBeGreaterThan(events.indexOf("blocked:UNBLOCKED"));
	});
});

async function scratch(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-ownership-lock-"));
	roots.push(root);
	return root;
}

function tracked(
	lockPath: string,
	events: string[],
	name: string,
	mode?: string,
): { readonly child: ChildProcess; readonly seen: (wanted: string, timeoutMs?: number) => Promise<void> } {
	const child = spawn(process.execPath, ["-e", childSource, lockPath, mode ?? ""], {
		stdio: ["pipe", "pipe", "inherit"],
	});
	children.push(child);
	let buffer = "";
	const waiters = new Map<string, () => void>();
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines.map((value) => value.trim()).filter((value) => value.length > 0)) {
			events.push(`${name}:${line}`);
			waiters.get(line)?.();
			waiters.delete(line);
		}
	});
	return {
		child,
		seen: (wanted, timeoutMs = 10_000) =>
			new Promise<void>((resolve, reject) => {
				if (events.includes(`${name}:${wanted}`)) return resolve();
				const timer = setTimeout(() => reject(new Error(`timed out waiting for ${name}:${wanted}`)), timeoutMs);
				waiters.set(wanted, () => {
					clearTimeout(timer);
					resolve();
				});
			}),
	};
}
