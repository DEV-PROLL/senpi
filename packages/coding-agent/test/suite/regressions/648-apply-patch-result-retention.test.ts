import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createApplyPatchTool,
	PATCH_PREVIEW_MAX_CHARS,
	PATCH_PREVIEW_MAX_LINES,
} from "../../../src/core/extensions/builtin/gpt-apply-patch/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("apply_patch result retention", () => {
	it("persists a bounded visible preview and metadata-only applied operations", async () => {
		const tempDir = await mkdtemp(path.join(tmpdir(), "senpi-apply-patch-retention-"));
		tempDirs.push(tempDir);
		const targetPath = path.join(tempDir, "sample.txt");
		const before = Array.from({ length: 24 }, (_, index) => `line ${index + 1} before`);
		const after = before.map((line) => line.replace("before", "after"));
		await writeFile(targetPath, `${before.join("\n")}\n`, "utf-8");

		const patch = `*** Begin Patch
*** Update File: sample.txt
@@
${before.map((line) => `-${line}`).join("\n")}
${after.map((line) => `+${line}`).join("\n")}
*** End Patch`;
		const tool = createApplyPatchTool();
		const result = await tool.execute("call-retention", { input: patch }, undefined, undefined, {
			cwd: tempDir,
		} as Parameters<typeof tool.execute>[4]);

		expect(await readFile(targetPath, "utf-8")).toBe(`${after.join("\n")}\n`);
		const preview = result.details?.preview;
		const patchResult = result.details?.result;
		expect(preview).toBeDefined();
		expect(patchResult).toBeDefined();
		if (!preview || !patchResult) throw new Error("apply_patch result details were missing");

		const visibleFile = preview.files[0];
		expect(visibleFile).toBeDefined();
		if (!visibleFile) throw new Error("apply_patch visible preview was missing");
		expect(visibleFile.diff.split("\n").length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_LINES);
		expect(visibleFile.diff.length).toBeLessThanOrEqual(PATCH_PREVIEW_MAX_CHARS);
		expect(visibleFile.diff).toContain("line 1 before");
		expect(visibleFile.diff).toContain("…");
		expect(visibleFile.patch).toContain("--- sample.txt");
		expect(visibleFile.patch).toContain("+++ sample.txt");
		expect(visibleFile.patch).toContain("-line 24 before");
		expect(visibleFile.patch).toContain("+line 24 after");

		expect(patchResult.details.appliedOperations).toEqual([
			{
				operationIndex: 0,
				preview: {
					filePath: "sample.txt",
					operation: "update",
					diff: "",
					added: 24,
					removed: 24,
				},
			},
		]);
	});
});
