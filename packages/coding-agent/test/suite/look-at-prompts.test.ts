import { describe, expect, it } from "vitest";
import { buildLookAtUserMessage } from "../../src/core/extensions/builtin/look-at/prompts.ts";

describe("look_at prompts", () => {
	it("puts the requested goal and every attached source label in the user message", () => {
		const message = buildLookAtUserMessage("Compare the warning states", ["before.png", "after.png"]);

		expect(message).toContain("Compare the warning states");
		expect(message).toContain("before.png");
		expect(message).toContain("after.png");
	});
});
