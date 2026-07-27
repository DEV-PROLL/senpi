import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExternalEditorOptions {
	command: string;
	content: string;
}

export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed" };

export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-"));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		const [editor, ...editorArgs] = options.command.split(" ");
		process.stdout.write(`Launching external editor: ${options.command}\nPi will resume when the editor exits.\n`);

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after the parent pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});

		if (exitCode !== 0) {
			return { status: "failed" };
		}

		return { status: "complete", content: readFileSync(filePath, "utf-8").replace(/\n$/, "") };
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}

export type EditFileResult = { status: "complete" } | { status: "exited"; code: number } | { status: "launch-failed" };

export async function editFileInExternalEditor(options: {
	command: string;
	path: string;
}): Promise<EditFileResult> {
	const [editor, ...editorArgs] = options.command.split(" ");
	const exitCode = await new Promise<number | null>((resolve) => {
		const child = spawn(editor, [...editorArgs, options.path], {
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.on("error", () => resolve(null));
		child.on("close", (code) => resolve(code));
	});

	// A spawn failure means the editor never ran, so a freshly seeded file is safe
	// to remove. A nonzero exit means the editor DID run and may have written the
	// file, so the caller must keep whatever is on disk.
	if (exitCode === null) return { status: "launch-failed" };
	return exitCode === 0 ? { status: "complete" } : { status: "exited", code: exitCode };
}
