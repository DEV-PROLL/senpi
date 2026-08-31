import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	bundledBunSkillPath,
	bunVersionSupportsSkill,
	createBunSkillDiscoverHandler,
	registerBunSkillContribution,
} from "../src/extension/skill-contribution.ts";

const bunSkillMd = join(import.meta.dirname, "..", "src", "skill", "bun-1-4", "SKILL.md");
const bunSkillRefs = join(import.meta.dirname, "..", "src", "skill", "bun-1-4", "references");

describe("bunVersionSupportsSkill", () => {
	it.each([
		{ version: "1.4.0", expected: true },
		{ version: "1.4.1", expected: true },
		{ version: "2.0.0", expected: true },
		{ version: "1.3.9", expected: false },
		{ version: "0.9.0", expected: false },
		{ version: undefined, expected: false },
		{ version: "garbage", expected: false },
	])("maps $version to $expected", ({ version, expected }) => {
		expect(bunVersionSupportsSkill(version)).toBe(expected);
	});
});

describe("bundledBunSkillPath", () => {
	it("returns the absolute bun-1-4 SKILL.md path that exists on disk", () => {
		const result = bundledBunSkillPath();
		expect(result).toBe(bunSkillMd);
		expect(result !== undefined && existsSync(result)).toBe(true);
	});
});

describe("createBunSkillDiscoverHandler", () => {
	it("contributes the bundled skill when the eval kernel runs bun 1.4.2", async () => {
		const handler = createBunSkillDiscoverHandler(() => "1.4.2");
		await expect(Promise.resolve(handler())).resolves.toEqual({ skillPaths: [bunSkillMd] });
	});

	it("contributes nothing when the eval kernel runs bun 1.3.0", async () => {
		const handler = createBunSkillDiscoverHandler(() => "1.3.0");
		await expect(Promise.resolve(handler())).resolves.toBeUndefined();
	});

	it("contributes nothing on a node kernel, regardless of any bun binary on PATH", async () => {
		const handler = createBunSkillDiscoverHandler(() => undefined);
		await expect(Promise.resolve(handler())).resolves.toBeUndefined();
	});

	it("contributes nothing when the kernel version is unparseable", async () => {
		const handler = createBunSkillDiscoverHandler(() => "not-a-version");
		await expect(Promise.resolve(handler())).resolves.toBeUndefined();
	});
});

describe("registerBunSkillContribution", () => {
	it("registers one resources_discover handler that contributes on a bun >= 1.4 kernel", async () => {
		const registrations: Array<{
			event: "resources_discover";
			handler: (
				event: unknown,
				ctx: unknown,
			) => Promise<{ skillPaths?: string[] } | undefined> | { skillPaths?: string[] } | undefined;
		}> = [];
		const pi = {
			on(
				event: "resources_discover",
				handler: (
					event: unknown,
					ctx: unknown,
				) => Promise<{ skillPaths?: string[] } | undefined> | { skillPaths?: string[] } | undefined,
			): void {
				registrations.push({ event, handler });
			},
		};

		registerBunSkillContribution(pi, () => "1.4.5");

		expect(registrations).toHaveLength(1);
		expect(registrations[0]?.event).toBe("resources_discover");
		await expect(Promise.resolve(registrations[0]?.handler({}, {}))).resolves.toEqual({ skillPaths: [bunSkillMd] });
	});
});

describe("bun-1-4 skill assets", () => {
	it("pins SKILL.md frontmatter name and exactly 10 reference markdown files", () => {
		expect(readFileSync(bunSkillMd, "utf8")).toContain("name: bun-1-4");
		const references = readdirSync(bunSkillRefs).filter((name) => name.endsWith(".md"));
		expect(references).toHaveLength(10);
	});

	it("ships a single document: one frontmatter block and one H1", () => {
		const text = readFileSync(bunSkillMd, "utf8");
		expect(text.match(/^---$/gm)).toHaveLength(2);
		expect(text.match(/^# Bun 1\.4/gm)).toHaveLength(1);
		expect(text.match(/^## Operating rules$/gm)).toHaveLength(1);
	});
});
