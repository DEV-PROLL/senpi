import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireOwnershipSafeLock, LegacyLockArtifactError } from "../src/modes/rpc/ownership-safe-lock.ts";

const roots: string[] = [];
const childSource = `
  import { acquireOwnershipSafeLock } from ${JSON.stringify(new URL("../src/modes/rpc/ownership-safe-lock.ts", import.meta.url).href)};
  const lock = await acquireOwnershipSafeLock(process.argv[1]);
  console.log("ACQUIRED");
  if (process.argv[2] === "block") {
    console.log("BLOCKED");
    const end = Date.now() + 2200;
    while (Date.now() < end) {}
    console.log("UNBLOCKED");
  }
  if (process.argv[2] === "hold") await new Promise(() => {});
  await lock();
  console.log("RELEASED");
`;

afterEach(async () => {
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

	it("serializes real children with release-before-acquisition order", async () => {
		const root = await scratch();
		const lockPath = join(root, "target.lock");
		const first = child(lockPath, "hold");
		await event(first, "ACQUIRED");
		const second = child(lockPath);
		await expectNoEvent(second, "ACQUIRED", 100);
		first.kill("SIGTERM");
		await event(second, "ACQUIRED");
		await stop(second);
	});

	it("releases a killed holder and keeps a blocked event loop exclusive", async () => {
		const root = await scratch();
		const lockPath = join(root, "target.lock");
		const holder = child(lockPath, "hold");
		await event(holder, "ACQUIRED");
		const waiter = child(lockPath);
		holder.kill("SIGKILL");
		await event(waiter, "ACQUIRED");
		await stop(waiter);

		const blocked = child(lockPath, "block");
		await event(blocked, "BLOCKED");
		const blockedWaiter = child(lockPath);
		const result = await Promise.race([event(blockedWaiter, "ACQUIRED"), event(blocked, "UNBLOCKED")]);
		expect(result).toBe("UNBLOCKED");
		await event(blockedWaiter, "ACQUIRED");
		await stop(blocked);
		await stop(blockedWaiter);
	});
});

async function scratch(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-ownership-lock-"));
	roots.push(root);
	return root;
}

function child(lockPath: string, mode?: string): ChildProcess {
	return spawn(process.execPath, ["-e", childSource, lockPath, mode ?? ""], { stdio: ["ignore", "pipe", "inherit"] });
}

function event(childProcess: ChildProcess, wanted: string, timeoutMs = 10_000): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${wanted}`)), timeoutMs);
		childProcess.stdout!.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			if (lines.includes(wanted)) {
				clearTimeout(timer);
				resolve(wanted);
			}
		});
	});
}

async function expectNoEvent(childProcess: ChildProcess, wanted: string, timeoutMs: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(resolve, timeoutMs);
		childProcess.stdout!.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			if (buffer.includes(wanted)) {
				clearTimeout(timer);
				reject(new Error(`${wanted} arrived while holder was live`));
			}
		});
	});
}

async function stop(childProcess: ChildProcess): Promise<void> {
	if (childProcess.exitCode !== null || childProcess.signalCode !== null) return;
	if (!childProcess.killed) childProcess.kill("SIGTERM");
	if (childProcess.exitCode !== null || childProcess.signalCode !== null) return;
	await new Promise<void>((resolve) => childProcess.once("exit", () => resolve()));
}
