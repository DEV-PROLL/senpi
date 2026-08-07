import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	// realpath: on macOS tmpdir() is a symlink (/var -> /private/var), but the
	// spawned CLI sees the physical path via process.cwd(). Session cwd
	// filtering compares paths textually, so the fixture must use physical paths.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-session-cross-project-")));
	tempDirs.push(dir);
	return dir;
}

interface CliDirs {
	agentDir: string;
	projectDir: string;
	otherProjectDir: string;
	sessionDir: string;
}

async function runCli(
	args: (dirs: CliDirs) => string[],
	setup?: (dirs: CliDirs) => void,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const tempRoot = createTempDir();
	const dirs: CliDirs = {
		agentDir: join(tempRoot, "agent"),
		projectDir: join(tempRoot, "project"),
		otherProjectDir: join(tempRoot, "other-project"),
		sessionDir: join(tempRoot, "sessions"),
	};
	mkdirSync(dirs.agentDir, { recursive: true });
	mkdirSync(dirs.projectDir, { recursive: true });
	mkdirSync(dirs.otherProjectDir, { recursive: true });
	setup?.(dirs);

	let stdout = "";
	let stderr = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, [cliPath, ...args(dirs)], {
			cwd: dirs.projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: dirs.agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
	});

	return { code, stdout, stderr };
}

function writeSession(sessionDir: string, cwd: string, id: string): void {
	writeFileSync(
		join(sessionDir, `${id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`,
	);
}

describe("--session with a session from another project", () => {
	it("fails fast with guidance instead of hanging on a non-interactive stdin", async () => {
		const sessionId = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3";
		const result = await runCli(
			(dirs) => ["--session-dir", dirs.sessionDir, "--session", sessionId, "-p", "hi"],
			(dirs) => {
				mkdirSync(dirs.sessionDir, { recursive: true });
				writeSession(dirs.sessionDir, dirs.otherProjectDir, sessionId);
			},
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Session found in different project:");
		expect(result.stderr).toContain(`--fork '${sessionId}'`);
	});
});
