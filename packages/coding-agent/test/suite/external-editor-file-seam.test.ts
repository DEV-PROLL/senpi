import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editFileInExternalEditor } from "../../src/modes/interactive/external-editor.ts";

describe("editFileInExternalEditor", () => {
	let directory: string;
	let editorPath: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "senpi-external-editor-file-"));
		editorPath = join(directory, "fake-editor.mjs");
		writeFileSync(
			editorPath,
			`import { appendFileSync, writeFileSync } from "node:fs";

const [mode, filePath] = process.argv.slice(2);
if (!filePath) process.exit(2);

if (mode === "append") {
	appendFileSync(filePath, "edited by editor\\n", "utf-8");
	process.exit(0);
}

if (mode === "fail") {
	writeFileSync(filePath, "left by failing editor\\n", "utf-8");
	process.exit(7);
}

if (mode === "signal") {
	writeFileSync(filePath, "edited before signal\\n", "utf-8");
	process.kill(process.pid, "SIGTERM");
}

process.exit(0);
`,
			"utf-8",
		);
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("opens the real target path and reports completion", async () => {
		const targetPath = join(directory, "keybindings.json");
		writeFileSync(targetPath, "original\n", "utf-8");

		const result = await editFileInExternalEditor({
			command: `${process.execPath} ${editorPath} append`,
			path: targetPath,
		});

		expect(result).toEqual({ status: "complete" });
		expect(readFileSync(targetPath, "utf-8")).toBe("original\nedited by editor\n");
	});

	it("reports failure and preserves the failing editor's file contents", async () => {
		const targetPath = join(directory, "keybindings.json");
		writeFileSync(targetPath, "original\n", "utf-8");

		const result = await editFileInExternalEditor({
			command: `${process.execPath} ${editorPath} fail`,
			path: targetPath,
		});

		// The editor RAN and wrote the file, so callers must keep what is on disk.
		expect(result).toEqual({ status: "exited", code: 7 });
		expect(readFileSync(targetPath, "utf-8")).toBe("left by failing editor\n");
	});

	it("reports failure without throwing when the editor cannot be launched", async () => {
		const targetPath = join(directory, "keybindings.json");
		writeFileSync(targetPath, "original\n", "utf-8");

		await expect(
			editFileInExternalEditor({
				command: `senpi-editor-that-does-not-exist-${process.pid}`,
				path: targetPath,
			}),
			// The editor never launched, so callers may safely discard a file they seeded.
		).resolves.toEqual({ status: "launch-failed" });
	});

	it("reports a signal-killed editor as launched so seeded content is preserved", async () => {
		// A process killed by a signal reports code === null on close, exactly like a
		// spawn failure. It DID run and may have written the file, so it must not take
		// the destructive launch-failed path.
		const targetPath = join(directory, "keybindings.json");
		writeFileSync(targetPath, "seeded\n", "utf-8");

		const result = await editFileInExternalEditor({
			command: `${process.execPath} ${editorPath} signal`,
			path: targetPath,
		});

		expect(result.status).not.toBe("launch-failed");
		expect(readFileSync(targetPath, "utf-8")).toBe("edited before signal\n");
	});

	it("does not create the target file when the editor leaves it untouched", async () => {
		const targetPath = join(directory, "missing-keybindings.json");

		const result = await editFileInExternalEditor({
			command: `${process.execPath} ${editorPath} noop`,
			path: targetPath,
		});

		expect(result).toEqual({ status: "complete" });
		expect(existsSync(targetPath)).toBe(false);
	});
});
