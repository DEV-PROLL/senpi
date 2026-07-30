import { spawnSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { getSelfUpdateCommand } from "../../../src/config.ts";

const originalExecPath = process.execPath;
const originalPath = process.env.PATH;
const originalPackageDir = process.env.PI_PACKAGE_DIR;
let fixtureRoot: string | undefined;

afterEach(() => {
	Object.defineProperty(process, "execPath", {
		value: originalExecPath,
		configurable: true,
	});
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalPackageDir === undefined) {
		delete process.env.PI_PACKAGE_DIR;
	} else {
		process.env.PI_PACKAGE_DIR = originalPackageDir;
	}
	if (fixtureRoot) {
		rmSync(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = undefined;
	}
});

test("preserves Bun execution when a Bun global self-update replaces the launcher with a Node symlink", () => {
	// Given: a Bun global package whose install step leaves a Node-shebang symlink.
	fixtureRoot = mkdtempSync(join(tmpdir(), "senpi-496-bun-launcher-"));
	const bunRoot = join(fixtureRoot, ".bun");
	const binDir = join(bunRoot, "bin");
	const packageDir = join(bunRoot, "install", "global", "node_modules", "@code-yeongyu", "senpi");
	const entrypoint = join(packageDir, "dist", "cli.js");
	const launcher = join(binDir, "senpi");
	mkdirSync(join(packageDir, "dist"), { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(entrypoint, "#!/usr/bin/env node\n");
	symlinkSync(entrypoint, launcher);
	const fakeBun = join(binDir, "bun");
	writeFileSync(
		fakeBun,
		`#!/bin/sh\nif [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then printf '%s\\n' '${binDir}'; exit 0; fi\nexit 1\n`,
	);
	chmodSync(fakeBun, 0o755);
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.PI_PACKAGE_DIR = packageDir;
	Object.defineProperty(process, "execPath", {
		value: entrypoint,
		configurable: true,
	});

	// When: the updater constructs and executes its post-install launcher repair.
	const command = getSelfUpdateCommand("@code-yeongyu/senpi");
	const steps = command?.steps ?? (command ? [command] : []);
	const repairStep = steps.at(-1);
	expect(repairStep?.args[0]).toBe("-e");
	const result = spawnSync(originalExecPath, repairStep?.args ?? [], { encoding: "utf8" });

	// Then: the launcher is a Bun wrapper rather than the Node entrypoint symlink.
	expect(result.status, result.stderr).toBe(0);
	expect(lstatSync(launcher).isSymbolicLink()).toBe(false);
	expect(readFileSync(launcher, "utf8")).toContain(`exec '${originalExecPath}' '${entrypoint}' "$@"`);
});
