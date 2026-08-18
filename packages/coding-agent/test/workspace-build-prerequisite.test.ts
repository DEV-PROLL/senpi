import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertWorkspaceBuildPrerequisite,
	findUnbuiltWorkspaceSpecifiers,
} from "./support/workspace-build-prerequisite.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A module URL outside the monorepo, so no workspace specifier resolves from it. */
function outsideWorkspaceModuleUrl(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-workspace-prereq-"));
	tempDirs.push(dir);
	return pathToFileURL(join(dir, "probe.mjs")).href;
}

describe("workspace build prerequisite", () => {
	it("reports every child-process specifier as unresolvable outside the workspace", () => {
		const missing = findUnbuiltWorkspaceSpecifiers(outsideWorkspaceModuleUrl());

		expect(missing).toEqual([
			"@earendil-works/pi-ai",
			"@earendil-works/pi-ai/compat",
			"@earendil-works/pi-tui",
			"@earendil-works/pi-agent-core",
			"@earendil-works/pi-agent-core/node",
		]);
	});

	it("names the unmet specifiers and the remedy when the prerequisite fails", () => {
		const probe = outsideWorkspaceModuleUrl();

		expect(() => assertWorkspaceBuildPrerequisite(probe)).toThrowError(/@earendil-works\/pi-agent-core\/node/);
		expect(() => assertWorkspaceBuildPrerequisite(probe)).toThrowError(/npm run build/);
	});

	it("passes for this suite, whose child processes require the built entrypoints", () => {
		// This is the live prerequisite: it holds exactly when the workspace is built,
		// which is what the spawned-CLI and worker tests in this suite depend on.
		expect(findUnbuiltWorkspaceSpecifiers(import.meta.url)).toEqual([]);
		expect(() => assertWorkspaceBuildPrerequisite(import.meta.url)).not.toThrow();
	});
});
