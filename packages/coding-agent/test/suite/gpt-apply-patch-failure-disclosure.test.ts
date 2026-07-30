import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyPatchDetailed,
	buildPartialFailureText,
} from "../../src/core/extensions/builtin/gpt-apply-patch/apply.ts";
import { createApplyPatchTool } from "../../src/core/extensions/builtin/gpt-apply-patch/tool.ts";
import type { Harness } from "./harness.ts";
import { createHarness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((h) => h.cleanup()));
});

describe("gpt-apply-patch failure disclosure (#31)", () => {
	it("surfaces the underlying failure message for a missing file (ENOENT)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const patch = `*** Begin Patch
*** Update File: missing.txt
@@
-old
+new
*** End Patch`;

		const result = await applyPatchDetailed(harness.tempDir, patch);

		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]?.message).toContain("ENOENT");

		const text = buildPartialFailureText(result);
		expect(text).toContain("missing.txt");
		expect(text).not.toContain("MUST read");
	});

	it("surfaces the underlying failure message for a context mismatch and advises reread", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "exists.txt"), "line\n", "utf-8");

		const patch = `*** Begin Patch
*** Update File: exists.txt
@@
-missing
+new
*** End Patch`;

		const result = await applyPatchDetailed(harness.tempDir, patch);

		expect(result.failures).toHaveLength(1);
		const text = buildPartialFailureText(result);
		expect(text).toContain("exists.txt");
		expect(text).toContain("MUST read exists.txt");
		expect(text).toMatch(/expected lines|context|find/i);
	});

	it("discloses failure messages via tool execute for a complete failure", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "broken.txt"), "line\n", "utf-8");

		const patch = `*** Begin Patch
*** Update File: broken.txt
@@
-missing
+changed
*** End Patch`;

		const tool = createApplyPatchTool();
		const result = await tool.execute("apply-patch-test", { input: patch }, undefined, undefined, {
			cwd: harness.tempDir,
		} as never);

		const text = result.content.find((block) => block.type === "text")?.text ?? "";
		expect(text).toContain("broken.txt");
		expect(text).toMatch(/expected lines|context|find/i);
	});
});

describe("gpt-apply-patch mutation queue (#28)", () => {
	it("serializes concurrent patches to the same file", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(path.join(harness.tempDir, "shared.txt"), "first\nsecond\n", "utf-8");

		const firstPatch = `*** Begin Patch
*** Update File: shared.txt
@@
-first
+FIRST
*** End Patch`;

		const secondPatch = `*** Begin Patch
*** Update File: shared.txt
@@
-second
+SECOND
*** End Patch`;

		await Promise.all([
			applyPatchDetailed(harness.tempDir, firstPatch),
			applyPatchDetailed(harness.tempDir, secondPatch),
		]);

		const content = await readFile(path.join(harness.tempDir, "shared.txt"), "utf-8");
		expect(content).toBe("FIRST\nSECOND\n");
	});
});
