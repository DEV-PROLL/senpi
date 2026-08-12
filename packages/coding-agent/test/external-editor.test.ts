import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ExternalEditorResult, editInExternalEditor } from "../src/modes/interactive/external-editor.ts";

const editorFixturePath = fileURLToPath(new URL("./fixtures/fake-external-editor.mjs", import.meta.url));
const externalEditorModulePath = fileURLToPath(new URL("../src/modes/interactive/external-editor.ts", import.meta.url));

interface EditorCapture {
	filePath: string;
	content: string;
	entries: string[];
	directoryMode: number;
}

async function runExternalEditor(fixtureFlag?: "--fail" | "--empty"): Promise<{
	result: ExternalEditorResult;
	capture: EditorCapture;
}> {
	const testDirectory = mkdtempSync(join(tmpdir(), "pi-external-editor-test-"));
	const capturePath = join(testDirectory, "capture.json");
	try {
		// These cases exercise editor-exit behavior. Launch-failure behavior has its own
		// real-OS regression below. Under full-suite subprocess pressure, a transient
		// EAGAIN can prevent the fixture from starting and therefore from writing its
		// capture file, so retry only that distinct pre-launch result.
		let result: ExternalEditorResult;
		let attempts = 0;
		do {
			result = await editInExternalEditor({
				command: `${process.execPath} ${editorFixturePath} ${capturePath}${fixtureFlag ? ` ${fixtureFlag}` : ""}`,
				content: "original",
			});
			attempts += 1;
		} while (result.status === "launch-failed" && attempts < 3);
		if (result.status === "launch-failed") {
			throw new Error(`Editor could not launch after ${attempts} attempts`);
		}
		const capture = JSON.parse(readFileSync(capturePath, "utf-8")) as EditorCapture;
		return { result, capture };
	} finally {
		rmSync(testDirectory, { recursive: true, force: true });
	}
}

async function runExternalEditorWithoutProcessSlot(): Promise<ExternalEditorResult> {
	const source = [
		'import { writeSync } from "node:fs";',
		`import { editInExternalEditor } from ${JSON.stringify(externalEditorModulePath)};`,
		'const result = await editInExternalEditor({ command: process.execPath + " -e process.exit(0)", content: "original" });',
		'writeSync(1, JSON.stringify(result) + "\\n");',
	].join(" ");
	const command =
		process.platform === "win32"
			? [process.execPath, "--experimental-strip-types", "-e", source]
			: [
					"/bin/sh",
					"-c",
					`ulimit -u 1; exec ${process.execPath} --experimental-strip-types -e ${JSON.stringify(source)}`,
				];
	const output = await new Promise<string>((resolve, reject) => {
		const child = spawn(command[0], command.slice(1), {
			stdio: ["ignore", "pipe", "pipe"],
			...(process.platform === "win32"
				? { env: { ...process.env, ComSpec: "Z:\\senpi-missing-command-shell.exe" } }
				: {}),
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve(stdout);
				return;
			}
			reject(new Error(`RLIMIT_NPROC helper exited ${code}: ${stderr}`));
		});
	});
	const line = output
		.trim()
		.split("\n")
		.findLast((entry) => entry.startsWith("{"));
	if (!line) throw new Error(`RLIMIT_NPROC helper returned no JSON result: ${output}`);
	return JSON.parse(line) as ExternalEditorResult;
}

describe("editInExternalEditor", () => {
	it("edits a prompt inside a private temporary directory", async () => {
		const { result, capture } = await runExternalEditor();
		const directory = dirname(capture.filePath);

		expect(result).toEqual({ status: "complete", content: "edited" });
		expect(dirname(directory)).toBe(tmpdir());
		expect(basename(directory)).toMatch(/^pi-editor-.+$/);
		expect(basename(capture.filePath)).toBe("prompt.md");
		expect(capture.entries).toEqual(["prompt.md"]);
		expect(capture.content).toBe("original");
		if (process.platform !== "win32") {
			expect(capture.directoryMode & 0o077).toBe(0);
		}
		expect(existsSync(directory)).toBe(false);
	});

	it("keeps the original content when the editor exits unsuccessfully", async () => {
		const { result, capture } = await runExternalEditor("--fail");

		expect(result).toEqual({ status: "failed" });
		expect(existsSync(dirname(capture.filePath))).toBe(false);
	});
	it("returns empty content when the editor clears the prompt", async () => {
		const { result } = await runExternalEditor("--empty");

		expect(result).toEqual({ status: "complete", content: "" });
	});

	it("reports when the editor cannot launch", async () => {
		const result = await runExternalEditorWithoutProcessSlot();

		expect(result).toEqual({ status: "launch-failed" });
	});
});
