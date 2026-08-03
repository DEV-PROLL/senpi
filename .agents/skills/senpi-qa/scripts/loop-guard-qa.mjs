#!/usr/bin/env node
// senpi-qa driver for the loop-guard builtin extension.
// Scripts tool-call loops through the REAL CLI against the local fake model
// server (zero tokens, sandboxed agent dir) and asserts the steered
// <system-reminder> reaches the provider's NEXT request body — the observable
// proof that the reminder entered the model's context. Also asserts a control
// scenario with varied calls fires nothing.
//
//   node .agents/skills/senpi-qa/scripts/loop-guard-qa.mjs --self-test
//   node .agents/skills/senpi-qa/scripts/loop-guard-qa.mjs --self-test --evidence loop-guard
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	runCli,
} from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import { API_PRESETS, checkRealAuthUnchanged, hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";

const argv = process.argv.slice(2);
const evidenceSlug = argv.includes("--evidence") ? argv[argv.indexOf("--evidence") + 1] : undefined;
const API = "openai-completions";
const IDENTICAL_HEADLINE = "LOOP GUARD - IDENTICAL TOOL CALLS";
const SIMILAR_HEADLINE = "LOOP GUARD - NEAR-IDENTICAL TOOL CALLS";
const CYCLE_HEADLINE = "LOOP GUARD - REPEATING TOOL-CALL PATTERN";

function rawBody(request) {
	return request.raw ?? JSON.stringify(request.body ?? {});
}

function hasReminder(request, headline) {
	const messages = request.body?.messages;
	if (!Array.isArray(messages)) return false;
	return messages.some(
		(message) =>
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some(
				(part) =>
					part?.type === "text" &&
					typeof part.text === "string" &&
					part.text.startsWith("<system-reminder>") &&
					(headline === undefined || part.text.includes(headline)),
			),
	);
}

async function drive({ turns, extraArgs = [] }) {
	const preset = API_PRESETS[API];
	const box = makeSandbox("loop-guard-qa");
	const server = await startFakeModelServer({ turns });
	writeMockModelsJson(box.agentDir, server, API);
	const args = [
		"--provider",
		preset.provider,
		"--model",
		preset.modelId,
		"--no-context-files",
		"--no-extensions",
		...extraArgs,
		"--print",
		"Run the scripted tools, then reply done.",
	];
	const result = await runCli(args, { env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs: 120000 });
	return { box, server, result };
}

async function expectReminder(checks, { name, turns, headline, minRequests, extraArgs }) {
	const { box, server, result } = await drive({ turns, extraArgs });
	const hitIndex = server.requests.findIndex((request, index) => index >= 1 && hasReminder(request, headline));
	const pass = result.code === 0 && server.requests.length >= minRequests && hitIndex >= 1;
	checks.ok(
		`${name}: reminder steered into a later provider request`,
		pass,
		`code=${result.code} requests=${server.requests.length} hitAt=${hitIndex}`,
	);
	if (!pass) {
		process.stderr.write(`\n--- ${name} stderr tail ---\n${result.stderr.slice(-800)}\n`);
	}
	if (evidenceSlug !== undefined) {
		const dir = evidenceDir(evidenceSlug);
		writeFileSync(
			join(dir, `${name}.json`),
			JSON.stringify(
				{
					headline,
					hitAt: hitIndex,
					requestCount: server.requests.length,
					exitCode: result.code,
					requestBodies: server.requests.map((request, index) => ({ index, url: request.url, raw: rawBody(request) })),
				},
				null,
				2,
			),
		);
	}
	await server.stop();
	box.cleanup();
	return pass;
}

async function selfTest() {
	installCleanupHooks();
	const checks = createChecks("loop-guard-qa.mjs --self-test");
	const guard = guardRealAuth();

	const identicalCall = { name: "bash", args: { command: "echo LOOP-GUARD-QA-IDENTICAL" } };
	await expectReminder(checks, {
		name: "identical",
		headline: IDENTICAL_HEADLINE,
		minRequests: 4,
		extraArgs: ["--approve"],
		turns: [{ toolCalls: [identicalCall] }, { toolCalls: [identicalCall] }, { toolCalls: [identicalCall] }, { text: "done" }],
	});

	const similarTurns = [1, 201, 401, 601, 801, 1001].map((offset) => ({
		toolCalls: [{ name: "bash", args: { command: `sed -n '${offset},${offset + 199}p' /tmp/loop-guard-qa-corpus.txt` } }],
	}));
	similarTurns.push({ text: "done" });
	await expectReminder(checks, {
		name: "similar",
		headline: SIMILAR_HEADLINE,
		minRequests: 6,
		extraArgs: ["--approve"],
		turns: similarTurns,
	});

	const cyclePair = [
		{ name: "bash", args: { command: "echo LOOP-GUARD-QA-CYCLE-A" } },
		{ name: "bash", args: { command: "echo LOOP-GUARD-QA-CYCLE-B" } },
	];
	const cycleTurns = [];
	for (let i = 0; i < 3; i++) {
		cycleTurns.push({ toolCalls: [cyclePair[0]] }, { toolCalls: [cyclePair[1]] });
	}
	cycleTurns.push({ text: "done" });
	await expectReminder(checks, {
		name: "cycle",
		headline: CYCLE_HEADLINE,
		minRequests: 7,
		extraArgs: ["--approve"],
		turns: cycleTurns,
	});

	{
		const loopGuardDir = join(
			process.cwd(),
			"packages/coding-agent/src/core/extensions/builtin/loop-guard",
		);
		const turns = ["detectors.ts", "notice.ts", "policy.ts", "similarity.ts", "tracker.ts"].map((fileName) => ({
			toolCalls: [{ name: "read", args: { path: join(loopGuardDir, fileName) } }],
		}));
		turns.push({ text: "done" });
		const { box, server, result } = await drive({ extraArgs: ["--approve"], turns });
		const leaked = server.requests.some((request) => hasReminder(request));
		const complete = server.requests.length >= turns.length;
		checks.ok(
			"distinct read targets: productive fan-out fires no reminder",
			result.code === 0 && complete && !leaked,
			`code=${result.code} requests=${server.requests.length} complete=${complete} leaked=${leaked}`,
		);
		if (evidenceSlug !== undefined) {
			const dir = evidenceDir(evidenceSlug);
			writeFileSync(
				join(dir, "distinct-read-targets.json"),
				JSON.stringify(
					{
						requestCount: server.requests.length,
						exitCode: result.code,
						complete,
						leaked,
						requestBodies: server.requests.map((request, index) => ({
							index,
							url: request.url,
							raw: rawBody(request),
						})),
					},
					null,
					2,
				),
			);
		}
		await server.stop();
		box.cleanup();
	}

	{
		const { box, server, result } = await drive({
			extraArgs: ["--approve"],
			turns: [
				{ toolCalls: [{ name: "bash", args: { command: "echo QA-VARIED-1" } }] },
				{ toolCalls: [{ name: "bash", args: { command: "git status --short" } }] },
				{ toolCalls: [{ name: "bash", args: { command: "npm run check" } }] },
				{ text: "done" },
			],
		});
		const leaked = server.requests
			.map(rawBody)
			.some((body) => body.includes(IDENTICAL_HEADLINE) || body.includes(SIMILAR_HEADLINE) || body.includes(CYCLE_HEADLINE));
		checks.ok("control: varied calls fire no reminder", result.code === 0 && !leaked, `code=${result.code} leaked=${leaked}`);
		await server.stop();
		box.cleanup();
	}

	checkRealAuthUnchanged(checks, guard);
	process.exit(checks.finish() ? 0 : 1);
}

await selfTest();
