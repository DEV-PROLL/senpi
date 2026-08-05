#!/usr/bin/env node

import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [binaryArgument, workerArgument, runtimeDirectoryArgument] = process.argv.slice(2);
if (!binaryArgument || !workerArgument) {
	throw new Error("Usage: smoke-standalone-binary.mjs <binary> <build-time-worker>");
}

const binaryPath = resolve(binaryArgument);
const workerPath = resolve(workerArgument);
if (!existsSync(binaryPath)) {
	throw new Error(`Standalone binary missing: ${binaryPath}`);
}
if (!existsSync(workerPath)) {
	throw new Error(`Build-time worker missing: ${workerPath}`);
}

const hiddenWorkerPath = `${workerPath}.senpi-smoke-hidden-${process.pid}`;
const smokeDirectory = runtimeDirectoryArgument
	? resolve(runtimeDirectoryArgument)
	: mkdtempSync(join(tmpdir(), "senpi-standalone-smoke-"));

try {
	renameSync(workerPath, hiddenWorkerPath);
	for (const argument of ["--help", "--version"]) {
		const result = spawnSync(binaryPath, [argument], {
			cwd: smokeDirectory,
			encoding: "utf8",
			env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat" },
		});
		if (result.error || result.status !== 0 || result.stdout.trim() === "") {
			const detail = result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`);
			throw new Error(`${basename(binaryPath)} ${argument} failed after relocation: ${detail}`);
		}
	}
} finally {
	if (existsSync(hiddenWorkerPath)) {
		renameSync(hiddenWorkerPath, workerPath);
	}
	if (!runtimeDirectoryArgument) {
		rmSync(smokeDirectory, { recursive: true, force: true });
	}
}

console.log("binary relocation smoke OK");
