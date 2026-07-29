import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverTtsrRules } from "../../src/core/extensions/builtin/ttsr/discovery.ts";

let rootDir = "";

beforeEach(async () => {
	rootDir = await mkdtemp(join(tmpdir(), "ttsr-discovery-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

function ttsrDir(base: string): string {
	return join(base, ".senpi", "ttsr");
}

async function writeRule(
	dir: string,
	fileName: string,
	frontmatter: readonly string[],
	body = "rule body",
): Promise<string> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, fileName);
	await writeFile(path, ["---", ...frontmatter, "---", body].join("\n"), "utf-8");
	return path;
}

describe("discoverTtsrRules", () => {
	it("discovers global and project rules, walking up from cwd", async () => {
		const home = join(rootDir, "home");
		const project = join(rootDir, "project");
		await writeRule(ttsrDir(home), "global-rule.md", ['condition: "global-needle"'], "global body");
		await writeRule(ttsrDir(project), "project-rule.md", ['condition: "project-needle"'], "project body");
		const cwd = join(project, "nested", "deep");
		await mkdir(cwd, { recursive: true });

		const { rules, warnings } = await discoverTtsrRules(cwd, home);

		expect(warnings).toEqual([]);
		expect(rules.map((rule) => rule.name)).toEqual(["global-rule", "project-rule"]);
		expect(rules.map((rule) => rule.source)).toEqual(["global", "project"]);
		const projectRule = rules.find((rule) => rule.name === "project-rule");
		expect(projectRule?.content).toBe("project body");
		expect(projectRule?.path).toBe(join(ttsrDir(project), "project-rule.md"));
	});

	it("lets project rules shadow global rules by name", async () => {
		const home = join(rootDir, "home");
		const project = join(rootDir, "project");
		await writeRule(ttsrDir(home), "shared.md", ['condition: "global-needle"'], "global body");
		await writeRule(ttsrDir(home), "other.md", ['condition: "other-needle"']);
		await writeRule(ttsrDir(project), "shared.md", ['condition: "project-needle"'], "project body");

		const { rules, warnings } = await discoverTtsrRules(project, home);

		expect(warnings).toEqual([]);
		expect(rules.map((rule) => rule.name)).toEqual(["other", "shared"]);
		const shared = rules.find((rule) => rule.name === "shared");
		expect(shared?.source).toBe("project");
		expect(shared?.content).toBe("project body");
	});

	it("skips malformed rules with a warning while valid siblings load", async () => {
		const home = join(rootDir, "home");
		const project = join(rootDir, "project");
		await writeRule(ttsrDir(project), "good.md", ['condition: "ok-needle"']);
		await writeRule(ttsrDir(project), "broken.md", ['condition: "["']);
		await writeRule(ttsrDir(project), "conditionless.md", ['description: "no condition here"']);

		const { rules, warnings } = await discoverTtsrRules(project, home);

		expect(rules.map((rule) => rule.name)).toEqual(["good"]);
		expect(warnings).toHaveLength(2);
		expect(warnings.some((warning) => warning.includes("broken"))).toBe(true);
		expect(warnings.some((warning) => warning.includes("conditionless"))).toBe(true);
	});

	it("returns empty results when discovery directories are missing", async () => {
		const home = join(rootDir, "home");
		const cwd = join(rootDir, "stray", "nested");
		await mkdir(cwd, { recursive: true });

		const { rules, warnings } = await discoverTtsrRules(cwd, home);

		expect(rules).toEqual([]);
		expect(warnings).toEqual([]);
	});

	it("skips rules whose scope is unreachable", async () => {
		const home = join(rootDir, "home");
		const project = join(rootDir, "project");
		await writeRule(ttsrDir(project), "reachable.md", ['condition: "ok"', 'scope: "text"']);
		await writeRule(ttsrDir(project), "unreachable.md", ['condition: "ok"', 'scope: "???"']);

		const { rules, warnings } = await discoverTtsrRules(project, home);

		expect(rules.map((rule) => rule.name)).toEqual(["reachable"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.includes("unreachable")).toBe(true);
	});

	it("orders rules deterministically: global alphabetical, then project alphabetical", async () => {
		const home = join(rootDir, "home");
		const project = join(rootDir, "project");
		await writeRule(ttsrDir(home), "charlie.md", ['condition: "c"']);
		await writeRule(ttsrDir(home), "alpha.md", ['condition: "a"']);
		await writeRule(ttsrDir(project), "zebra.md", ['condition: "z"']);
		await writeRule(ttsrDir(project), "bravo.md", ['condition: "b"']);

		const { rules } = await discoverTtsrRules(project, home);

		expect(rules.map((rule) => rule.name)).toEqual(["alpha", "charlie", "bravo", "zebra"]);
	});

	it("resolves the nearest ancestor with a .senpi directory as project root", async () => {
		const home = join(rootDir, "home");
		const outer = join(rootDir, "outer");
		const inner = join(outer, "inner");
		await writeRule(ttsrDir(outer), "outer-rule.md", ['condition: "outer"']);
		await writeRule(ttsrDir(inner), "inner-rule.md", ['condition: "inner"']);
		const cwd = join(inner, "src", "pkg");
		await mkdir(cwd, { recursive: true });

		const { rules, warnings } = await discoverTtsrRules(cwd, home);

		expect(warnings).toEqual([]);
		expect(rules.map((rule) => rule.name)).toEqual(["inner-rule"]);
		expect(rules[0]?.path).toBe(join(ttsrDir(inner), "inner-rule.md"));
	});

	it("treats the home directory as global only, never as project", async () => {
		const home = join(rootDir, "home");
		await writeRule(ttsrDir(home), "solo.md", ['condition: "s"']);
		const cwd = join(home, "work");
		await mkdir(cwd, { recursive: true });

		const { rules, warnings } = await discoverTtsrRules(cwd, home);

		expect(warnings).toEqual([]);
		expect(rules.map((rule) => rule.name)).toEqual(["solo"]);
		expect(rules[0]?.source).toBe("global");
	});
});
