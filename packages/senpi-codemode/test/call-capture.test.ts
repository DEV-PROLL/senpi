import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import { boundToolCallArgs, capCodePoints, toolCallResultPreview } from "../src/tool/call-capture.ts";

describe("tool-call capture helpers", () => {
	it("keeps surrogate pairs intact when capping code points", () => {
		const capped = capCodePoints("😀x", 1);

		expect(capped).toBe("😀…");
		expect([...capped]).toEqual(["😀", "…"]);
	});

	it("strips ANSI escapes and collapses whitespace in result previews", () => {
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "evil\u001b[31mred\u001b[0m\n  output" }],
			details: {},
		};

		expect(toolCallResultPreview(result)).toBe("evilred output");
	});

	it("retains a capped ten-thousand-character string argument", () => {
		const expectedBlob = `${"x".repeat(512)}…`;
		const captured = boundToolCallArgs({ blob: "x".repeat(10_000) });

		expect(captured.truncated).toBe(true);
		expect(captured.args).toEqual({ blob: expectedBlob });
		expect([...expectedBlob]).toHaveLength(513);
	});

	it("omits arguments whose retained serialization exceeds the total budget", () => {
		const many: Record<string, string> = {};
		for (let index = 0; index < 20; index += 1) many[`key-${index}`] = "x".repeat(400);

		expect(boundToolCallArgs(many)).toEqual({ args: undefined, truncated: true });
	});

	it("replaces depth-seven subtrees with an ellipsis", () => {
		const deep = { one: { two: { three: { four: { five: { six: { seven: "too deep" } } } } } } };

		expect(boundToolCallArgs(deep)).toEqual({
			args: { one: { two: { three: { four: { five: { six: "…" } } } } } },
			truncated: true,
		});
	});

	it("keeps only the first thirty-two array elements", () => {
		const captured = boundToolCallArgs(Array.from({ length: 40 }, (_, index) => index));

		expect(captured).toEqual({ args: Array.from({ length: 32 }, (_, index) => index), truncated: true });
	});

	it("omits cyclic objects instead of throwing", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		expect(boundToolCallArgs(cyclic)).toEqual({ args: undefined, truncated: true });
	});

	it("returns no preview for image-only result content", () => {
		const result: AgentToolResult<unknown> = {
			content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }],
			details: {},
		};

		expect(toolCallResultPreview(result)).toBeUndefined();
	});

	it("passes through small clean arguments", () => {
		const args = { path: "/tmp/x.txt", offset: 1, nested: [true, null] };

		expect(boundToolCallArgs(args)).toEqual({ args, truncated: false });
	});
});
