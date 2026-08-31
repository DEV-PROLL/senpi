import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type BunSkillProbe,
	bundledBunSkillPath,
	bunVersionSupportsSkill,
	createBunSkillDiscoverHandler,
	registerBunSkillContribution,
} from "../src/extension/skill-contribution.ts";

const bunSkillMd = join(import.meta.dirname, "..", "src", "skill", "bun-1-4", "SKILL.md");
const bunSkillRefs = join(import.meta.dirname, "..", "src", "skill", "bun-1-4", "references");

function probe(pathVersion: string | undefined, runtimeVersion?: string): BunSkillProbe {
	return {
		probePathBunVersion: async () => pathVersion,
		runtimeBunVersion: () => runtimeVersion,
	};
}

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
	it("contributes the bundled skill when path bun is 1.4.2", async () => {
		const handler = createBunSkillDiscoverHandler(probe("1.4.2"));
		await expect(handler()).resolves.toEqual({ skillPaths: [bunSkillMd] });
	});

	it("contributes nothing when path bun is 1.3.0", async () => {
		const handler = createBunSkillDiscoverHandler(probe("1.3.0"));
		await expect(handler()).resolves.toBeUndefined();
	});

	it("falls back to runtime bun 1.4.0 when the path probe is missing", async () => {
		const handler = createBunSkillDiscoverHandler(probe(undefined, "1.4.0"));
		await expect(handler()).resolves.toEqual({ skillPaths: [bunSkillMd] });
	});

	it("contributes nothing when both path and runtime bun are missing", async () => {
		const handler = createBunSkillDiscoverHandler(probe(undefined));
		await expect(handler()).resolves.toBeUndefined();
	});

	it("probes path bun version only once for the same handler", async () => {
		let counter = 0;
		const handler = createBunSkillDiscoverHandler({
			probePathBunVersion: async () => {
				counter += 1;
				return "1.4.2";
			},
			runtimeBunVersion: () => undefined,
		});
		await handler();
		await handler();
		expect(counter).toBe(1);
	});
});

describe("registerBunSkillContribution", () => {
	it("registers one resources_discover handler that contributes the gated-in skill", async () => {
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

		registerBunSkillContribution(pi, probe("1.4.2"));

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
});
