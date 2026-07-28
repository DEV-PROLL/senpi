import assert from "node:assert";
import { describe, it } from "node:test";
import { consumeTmuxFocusEvent } from "../src/tmux-focus.ts";

describe("tmux focus events", () => {
	it("extracts focus transitions without swallowing adjacent input", () => {
		assert.deepStrictEqual(consumeTmuxFocusEvent("\x1b[I"), { event: "in", data: "" });
		assert.deepStrictEqual(consumeTmuxFocusEvent("\x1b[O"), { event: "out", data: "" });
		assert.deepStrictEqual(consumeTmuxFocusEvent(`\x1b[Ihello`), { event: "in", data: "hello" });
		assert.deepStrictEqual(consumeTmuxFocusEvent("hello"), { event: null, data: "hello" });
	});
});
