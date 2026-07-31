import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	cliEntry,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
	stripAnsi,
	tsxEntry,
} from "./lib/common.mjs";
import { startFallbackAbortServer } from "./lib/fallback-abort-server.mjs";
import {
	hermeticEnv,
	PROVIDER_ENV_KEYS,
	writeMockModelsJson,
} from "./lib/mock-loop-support.mjs";
import { renderTerminalScreenshot } from "./lib/terminal-screenshot.mjs";
import { startTmuxTui } from "./lib/tmux-tui-driver.mjs";

const PRIMARY_MODEL = "claude-fable-5";
const FALLBACK_MODEL = "claude-opus-5";
const ABORT_MARKERS = [
	"Aborted after 1 retry attempt",
	"Retry failed after 1 attempts:",
];
const TREE_MARKERS = ["filters", "cycle"];

async function main() {
	const args = process.argv.slice(2);
	if (!args.includes("--self-test")) {
		process.stdout.write("usage: node tui-fallback-abort-history.mjs --self-test --evidence SLUG\n");
		return;
	}
	const evidenceArg = args.indexOf("--evidence");
	const slug = evidenceArg >= 0 ? args[evidenceArg + 1] : "fallback-abort-session-history";
	if (!slug) throw new Error("--evidence requires a slug");

	installCleanupHooks();
	const root = repoRoot();
	const evidence = sharedEvidenceDir(root, slug);
	const box = makeSandbox("senpi-qa-fallback-abort-history");
	const guard = guardRealAuth();
	const server = await startFallbackAbortServer();
	let terminal;
	let terminalExited = false;
	let serverStopped = false;

	try {
		writeMockModelsJson(
			box.agentDir,
			{ origin: server.origin, url: `${server.origin}/v1` },
			"anthropic-messages",
			{ id: PRIMARY_MODEL, name: "Fable 5 QA" },
			{
				models: [{ id: FALLBACK_MODEL, name: "Opus 5 QA" }],
				retry: {
					enabled: true,
					maxRetries: 1,
					baseDelayMs: 0,
					provider: { maxRetries: 0, maxRetryDelayMs: 60_000 },
					fallbackChains: {
						[`anthropic/${PRIMARY_MODEL}`]: [`anthropic/${FALLBACK_MODEL}`],
					},
				},
			},
		);
		const env = hermeticEnv(box.env);
		for (const key of PROVIDER_ENV_KEYS) env[key] = "";
		env.SENPI_QA_MODELS_JSON = join(box.agentDir, "models.json");
		terminal = startTmuxTui({
			cwd: box.cwd,
			env,
			command: process.execPath,
			args: [
				tsxEntry(root),
				"--tsconfig",
				join(root, "tsconfig.json"),
				cliEntry(root),
				"--model",
				`anthropic/${PRIMARY_MODEL}`,
				"--no-context-files",
				"--no-skills",
				"--no-extensions",
				"--approve",
			],
			capturePath: join(box.dir, "terminal.ansi"),
			cols: 120,
			rows: 36,
		});

		await terminal.waitFor(
			(text) => text.includes("Fable 5 QA") || text.includes(PRIMARY_MODEL),
			"initial TUI model render",
		);
		terminal.submit("trigger fallback abort");
		const terminalText = await terminal.waitFor(
			(text) => ABORT_MARKERS.some((marker) => text.includes(marker)),
			"terminal retry failure",
		);
		const abortMarker = ABORT_MARKERS.find((marker) => terminalText.includes(marker));
		if (!abortMarker) throw new Error("terminal retry failure marker was not retained");

		const postAbortOffset = terminal.getRaw().length;
		const postAbortTextOffset = stripAnsi(terminal.getRaw()).length;
		terminal.escape();
		await waitDoubleEscapeGap();
		const afterOne = stripAnsi(terminal.getRaw().slice(postAbortOffset));
		if (TREE_MARKERS.some((marker) => afterOne.includes(marker))) {
			throw new Error("single Escape unexpectedly opened the session-history tree");
		}

		terminal.escape();
		await terminal.waitFor(
			(text) => TREE_MARKERS.some((marker) => text.slice(postAbortTextOffset).includes(marker)),
			"session-history tree markers",
		);
		const raw = terminal.getRaw();
		const plain = stripAnsi(raw);
		assertRequests(server.requests);
		if (!plain.includes(abortMarker)) throw new Error(`missing terminal marker: ${abortMarker}`);

		writeFileSync(join(evidence, "terminal.ansi"), raw);
		writeFileSync(join(evidence, "terminal.txt"), plain);
		renderTerminalScreenshot(root, evidence, raw);
		guard.assertUnchanged();
		writeFileSync(
			join(evidence, "summary.json"),
			JSON.stringify(
				{
					command:
						"node .agents/skills/senpi-qa/scripts/tui-fallback-abort-history.mjs --self-test --evidence fallback-abort-session-history",
					primaryModel: PRIMARY_MODEL,
					fallbackModel: FALLBACK_MODEL,
					requests: server.requests,
					abortMarker,
					treeMarkers: TREE_MARKERS,
					singleEscapeOpenedTree: false,
					doubleEscapeOpenedTree: true,
					authPath: guard.path,
					authUnchanged: true,
				},
				null,
				2,
			),
		);
		process.stdout.write(`[PASS] terminal fallback abort reached: ${abortMarker}\n`);
		process.stdout.write("[PASS] one Escape left history closed\n");
		process.stdout.write("[PASS] two Escapes rendered the session-history tree\n");
		process.stdout.write(`[PASS] screenshot: ${join(evidence, "terminal.png")}\n`);
	} finally {
		if (terminal) {
			const attemptRaw = terminal.getRaw();
			if (attemptRaw) {
				writeFileSync(join(evidence, "attempt-terminal.ansi"), attemptRaw);
				writeFileSync(join(evidence, "attempt-terminal.txt"), stripAnsi(attemptRaw));
			}
		}
		writeFileSync(
			join(evidence, "attempt-requests.json"),
			JSON.stringify(server.requests, null, 2),
		);
		if (terminal) terminalExited = terminal.stop();
		await server.stop();
		serverStopped = !server.listening;
		box.cleanup();
		const cleanup = {
			terminalExited: terminalExited || terminal === undefined,
			serverStopped,
			sandboxRemoved: !existsSync(box.dir),
		};
		writeFileSync(join(evidence, "cleanup.json"), JSON.stringify(cleanup, null, 2));
		if (!cleanup.serverStopped || !cleanup.sandboxRemoved) {
			throw new Error(`QA cleanup incomplete: ${JSON.stringify(cleanup)}`);
		}
		if (!cleanup.terminalExited) throw new Error("QA terminal did not exit");
	}
}

function waitDoubleEscapeGap() {
	return new Promise((resolve) => setTimeout(resolve, 100));
}

function assertRequests(requests) {
	const models = requests.map((request) => request.model);
	const expected = [PRIMARY_MODEL, FALLBACK_MODEL];
	if (JSON.stringify(models.slice(0, 2)) !== JSON.stringify(expected)) {
		throw new Error(`unexpected fallback request sequence: ${JSON.stringify(models)}`);
	}
	if (models.slice(2).some((model) => model !== FALLBACK_MODEL)) {
		throw new Error(`unexpected post-turn request model: ${JSON.stringify(models)}`);
	}
}

function sharedEvidenceDir(root, slug) {
	const commonGitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const checkoutRoot = dirname(resolve(root, commonGitDir));
	const dir = join(checkoutRoot, "local-ignore", "qa-evidence", `20260731-${slug}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
