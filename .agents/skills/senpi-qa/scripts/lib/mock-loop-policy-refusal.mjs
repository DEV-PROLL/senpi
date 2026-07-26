import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	FALLBACK_MODEL_ID,
	FINAL_MARKER,
	PRIMARY_CONTINUED_MARKER,
	startPolicyRefusalServer,
} from "./anthropic-policy-refusal-server.mjs";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	runCli,
} from "./common.mjs";
import {
	API_PRESETS,
	checkRealAuthUnchanged,
	hermeticEnv,
	writeMockModelsJson,
} from "./mock-loop-support.mjs";

const API_NAME = "anthropic-messages";
export async function runAnthropicPolicyRefusalScenario(evidenceSlug) {
	installCleanupHooks();
	const checks = createChecks("mock-loop.mjs --scenario anthropic-policy-refusal-fallback");
	const guard = guardRealAuth();
	const box = makeSandbox("senpi-qa-policy-refusal");
	const server = await startPolicyRefusalServer();
	const preset = API_PRESETS[API_NAME];
	const evidence = evidenceSlug ? evidenceDir(evidenceSlug) : undefined;
	let result;
	let fallbackLog = "";
	let assistantMessages = [];
	try {
		writeMockModelsJson(box.agentDir, server, API_NAME, {}, {
			models: [{ id: FALLBACK_MODEL_ID }],
			retry: {
				enabled: true,
				maxRetries: 3,
				baseDelayMs: 0,
				provider: { maxRetries: 0, maxRetryDelayMs: 60000 },
				fallbackChains: {
					[`${preset.provider}/${preset.modelId}`]: [`${preset.provider}/${FALLBACK_MODEL_ID}`],
				},
			},
		});
		result = await runCli(
			[
				"--provider",
				preset.provider,
				"--model",
				preset.modelId,
				"--print",
				"--no-extensions",
				"Trigger the scripted Anthropic policy refusal and return the fallback marker.",
			],
			{ env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs: 60000 },
		);
		assistantMessages = readAssistantMessages(box.sessionDir);
		const fallbackLogPath = join(box.agentDir, "logs", "fallback.log");
		if (existsSync(fallbackLogPath)) fallbackLog = readFileSync(fallbackLogPath, "utf8");
		const modelSequence = server.requests.map((request) => request.model);
		const applied = fallbackLog
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.find((entry) => entry.event === "fallback_applied");
		const markerReturned = `${result.stdout}${result.stderr}`.includes(FINAL_MARKER);
		const pass =
			result.code === 0 &&
			!result.timedOut &&
			JSON.stringify(modelSequence) === JSON.stringify([preset.modelId, FALLBACK_MODEL_ID]) &&
			applied?.reason === "refusal" &&
			markerReturned &&
			!`${result.stdout}${result.stderr}`.includes(PRIMARY_CONTINUED_MARKER);
		process.stdout.write(
			`SENPI_QA_POLICY_REFUSAL_TRANSCRIPT sequence=${modelSequence.join(" -> ") || "none"} reason=${applied?.reason ?? "none"} marker=${markerReturned}\n`,
		);
		checks.ok(
			"Anthropic policy refusal switches immediately to the configured fallback",
			pass,
			`code=${result.code} sequence=${modelSequence.join(" -> ") || "none"} reason=${applied?.reason ?? "none"} marker=${markerReturned}`,
		);
		checkRealAuthUnchanged(checks, guard);
		if (evidence) writeEvidence(evidence, result, server.requests, fallbackLog, assistantMessages);
	} finally {
		await server.stop();
		box.cleanup();
		if (evidence) {
			writeFileSync(
				join(evidence, "cleanup.json"),
				JSON.stringify(
					{
						serverListening: server.listening,
						sandboxExists: existsSync(box.dir),
						receipt: `server closed; removed ${box.dir}`,
					},
					null,
					2,
				),
			);
		}
	}
	process.exit(checks.finish() ? 0 : 1);
}

function readAssistantMessages(sessionDir) {
	const messages = [];
	for (const relativePath of readdirSync(sessionDir, { recursive: true })) {
		if (typeof relativePath !== "string" || !relativePath.endsWith(".jsonl")) continue;
		const lines = readFileSync(join(sessionDir, relativePath), "utf8").split(/\r?\n/).filter(Boolean);
		for (const line of lines) {
			const event = JSON.parse(line);
			if (event.type !== "message" || event.message?.role !== "assistant") continue;
			messages.push({
				stopReason: event.message.stopReason,
				errorMessage: event.message.errorMessage,
				stopDetails: event.message.stopDetails,
				contentTypes: event.message.content?.map((content) => content.type),
			});
		}
	}
	return messages;
}

function writeEvidence(dir, result, requests, fallbackLog, assistantMessages) {
	writeFileSync(join(dir, "stdout.txt"), result.stdout);
	writeFileSync(join(dir, "stderr.txt"), result.stderr);
	writeFileSync(join(dir, "requests.json"), JSON.stringify(requests, null, 2));
	writeFileSync(join(dir, "assistant-messages.json"), JSON.stringify(assistantMessages, null, 2));
	writeFileSync(join(dir, "fallback.log"), fallbackLog);
	writeFileSync(
		join(dir, "summary.json"),
		JSON.stringify(
			{
				command:
					"node .agents/skills/senpi-qa/scripts/mock-loop.mjs --scenario anthropic-policy-refusal-fallback --evidence anthropic-policy-refusal-fallback",
				exitCode: result.code,
				timedOut: result.timedOut,
			},
			null,
			2,
		),
	);
	process.stderr.write(`evidence: ${dir}\n`);
}
