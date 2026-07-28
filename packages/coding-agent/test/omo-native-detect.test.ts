import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectOmoNativeInstall } from "../src/core/omo-native-detect.ts";
import type { PackageSource } from "../src/core/settings-manager.ts";

/**
 * Build a temp "omo repo" with the layout detectOmoNativeInstall expects:
 *   <repoRoot>/packages/omo-senpi/package.json   name @oh-my-opencode/omo-senpi
 *   <repoRoot>/packages/senpi-task/package.json  name @oh-my-opencode/senpi-task
 *   <repoRoot>/a/b/c/package.json                 name @code-yeongyu/omo-senpi  (plugin install path, 3 deep)
 * pluginPath/../../.. resolves to repoRoot, matching the beta detectOmoLocalInstall derivation.
 */
function buildRepo(opts: {
	omoSenpiWorkspaceName?: string;
	senpiTaskWorkspaceName?: string;
	pluginName?: string;
	skipSenpiTask?: boolean;
	skipOmoSenpiWorkspace?: boolean;
	skipPluginPackageJson?: boolean;
}): { repoRoot: string; pluginPath: string } {
	const repoRoot = mkdtempSync(join(tmpdir(), "omo-native-detect-"));
	mkdirSync(join(repoRoot, "packages"), { recursive: true });
	if (!opts.skipOmoSenpiWorkspace) {
		mkdirSync(join(repoRoot, "packages", "omo-senpi"), { recursive: true });
		writeFileSync(
			join(repoRoot, "packages", "omo-senpi", "package.json"),
			JSON.stringify({ name: opts.omoSenpiWorkspaceName ?? "@oh-my-opencode/omo-senpi" }),
		);
	}
	if (!opts.skipSenpiTask) {
		mkdirSync(join(repoRoot, "packages", "senpi-task"), { recursive: true });
		writeFileSync(
			join(repoRoot, "packages", "senpi-task", "package.json"),
			JSON.stringify({ name: opts.senpiTaskWorkspaceName ?? "@oh-my-opencode/senpi-task" }),
		);
	}
	const pluginPath = join(repoRoot, "a", "b", "c");
	mkdirSync(pluginPath, { recursive: true });
	if (!opts.skipPluginPackageJson) {
		writeFileSync(
			join(pluginPath, "package.json"),
			JSON.stringify({ name: opts.pluginName ?? "@code-yeongyu/omo-senpi" }),
		);
	}
	return { repoRoot, pluginPath };
}

const createdDirs: string[] = [];
afterEach(() => {
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
	createdDirs.length = 0;
});

describe("detectOmoNativeInstall", () => {
	it("returns true when a local-path @code-yeongyu/omo-senpi plugin has both workspace packages", () => {
		const { pluginPath } = buildRepo({});
		createdDirs.push(pluginPath);
		const packages: PackageSource[] = [pluginPath];
		expect(detectOmoNativeInstall(packages, "/tmp/nonexistent-agent-dir")).toBe(true);
	});

	it("accepts the object package-source form", () => {
		const { pluginPath } = buildRepo({});
		createdDirs.push(pluginPath);
		const packages: PackageSource[] = [{ source: pluginPath, autoload: true }];
		expect(detectOmoNativeInstall(packages, "/tmp/nonexistent-agent-dir")).toBe(true);
	});

	it("returns false for undefined packages", () => {
		expect(detectOmoNativeInstall(undefined, "/tmp/nonexistent-agent-dir")).toBe(false);
	});

	it("returns false for an empty packages array", () => {
		expect(detectOmoNativeInstall([], "/tmp/nonexistent-agent-dir")).toBe(false);
	});

	it("returns false for non-local package sources (npm:, git:, https:)", () => {
		const packages: PackageSource[] = [
			"npm:@code-yeongyu/omo-senpi",
			"git:github.com/foo/bar",
			"https://example.com",
		];
		expect(detectOmoNativeInstall(packages, "/tmp/nonexistent-agent-dir")).toBe(false);
	});

	it("returns false when the local-path plugin package name is not @code-yeongyu/omo-senpi", () => {
		const { pluginPath } = buildRepo({ pluginName: "@some-other/package" });
		createdDirs.push(pluginPath);
		const packages: PackageSource[] = [pluginPath];
		expect(detectOmoNativeInstall(packages, "/tmp/nonexistent-agent-dir")).toBe(false);
	});

	it("returns false when the plugin package.json is missing", () => {
		const { pluginPath } = buildRepo({ skipPluginPackageJson: true });
		createdDirs.push(pluginPath);
		const packages: PackageSource[] = [pluginPath];
		expect(detectOmoNativeInstall(packages, "/tmp/nonexistent-agent-dir")).toBe(false);
	});

	it("returns false when the senpi-task workspace package is missing", () => {
		const { pluginPath } = buildRepo({ skipSenpiTask: true });
		createdDirs.push(pluginPath);
		const packages: PackageSource[] = [pluginPath];
		expect(detectOmoNativeInstall(packages, "/tmp/nonexistent-agent-dir")).toBe(false);
	});

	it("returns false when the omo-senpi workspace package is missing", () => {
		const { pluginPath } = buildRepo({ skipOmoSenpiWorkspace: true });
		createdDirs.push(pluginPath);
		const packages: PackageSource[] = [pluginPath];
		expect(detectOmoNativeInstall(packages, "/tmp/nonexistent-agent-dir")).toBe(false);
	});

	it("returns false when the omo-senpi workspace package name is wrong", () => {
		const { pluginPath } = buildRepo({ omoSenpiWorkspaceName: "@wrong/omo-senpi" });
		createdDirs.push(pluginPath);
		const packages: PackageSource[] = [pluginPath];
		expect(detectOmoNativeInstall(packages, "/tmp/nonexistent-agent-dir")).toBe(false);
	});

	it("returns false when the senpi-task workspace package name is wrong", () => {
		const { pluginPath } = buildRepo({ senpiTaskWorkspaceName: "@wrong/senpi-task" });
		createdDirs.push(pluginPath);
		const packages: PackageSource[] = [pluginPath];
		expect(detectOmoNativeInstall(packages, "/tmp/nonexistent-agent-dir")).toBe(false);
	});

	it("returns false when a local path points to a non-existent directory", () => {
		const packages: PackageSource[] = ["/tmp/definitely-not-a-real-path-omo-native"];
		expect(detectOmoNativeInstall(packages, "/tmp/nonexistent-agent-dir")).toBe(false);
	});

	it("returns true when the omo-senpi plugin is the second of two package entries", () => {
		const { pluginPath } = buildRepo({});
		createdDirs.push(pluginPath);
		const packages: PackageSource[] = ["npm:some/other-package", pluginPath];
		expect(detectOmoNativeInstall(packages, "/tmp/nonexistent-agent-dir")).toBe(true);
	});
});
