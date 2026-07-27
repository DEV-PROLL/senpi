import { describe, expect, it } from "vitest";
import { z } from "zod";
import { denyCustomToolExecution } from "../src/core/extensions/builtin/claude-agent-sdk/custom-tools.ts";
import { jsonSchemaToZodShape } from "../src/core/extensions/builtin/claude-agent-sdk/custom-tools-schema.ts";

describe("jsonSchemaToZodShape", () => {
	it("converts TypeBox-style object schemas with required/optional fields", () => {
		const shape = jsonSchemaToZodShape({
			type: "object",
			properties: {
				path: { type: "string" },
				count: { type: "integer" },
				verbose: { type: "boolean" },
				mode: { enum: ["fast", "slow"] },
				tags: { type: "array", items: { type: "string" } },
			},
			required: ["path", "count"],
		});
		const object = z.object(shape);
		expect(object.safeParse({ path: "a", count: 2 }).success).toBe(true);
		expect(object.safeParse({ count: 2 }).success).toBe(false);
		expect(object.safeParse({ path: "a", count: 2, mode: "fast", tags: ["x"] }).success).toBe(true);
		expect(object.safeParse({ path: "a", count: 2, mode: "other" }).success).toBe(false);
		expect(object.safeParse({ path: "a", count: 2, verbose: true }).success).toBe(true);
	});

	it("produces an empty shape for missing properties", () => {
		expect(jsonSchemaToZodShape(undefined)).toEqual({});
		expect(jsonSchemaToZodShape({ type: "object" })).toEqual({});
	});
});

describe("custom tool advertisement", () => {
	it("deny handler always refuses execution with the denial message", async () => {
		const result = await denyCustomToolExecution();
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("unavailable");
	});
});
