import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks } from "./common.mjs";

const CTRL_SEP = ["<", "|", "sep", "|", ">"].join("");
const BANG_RUN_300 = /!{300}/;

export const TTSR_SCENARIOS = ["ttsr-collapse", "ttsr-leak", "ttsr-repetitive-turns"];

export function isTtsrScenario(name) {
	return TTSR_SCENARIOS.includes(name);
}

function check(name, pass, detail) {
	return { name, pass, detail };
}

function writeTtsrEvidence(slug, scenarioName, result, server) {
	const dir = evidenceDir(slug);
	writeFileSync(join(dir, `${scenarioName}-stdout.txt`), `${result.stdout}\n${result.stderr}`);
	writeFileSync(join(dir, `${scenarioName}-requests.json`), JSON.stringify(server.requests, null, 2));
	process.stderr.write(`evidence: ${dir}\n`);
}

const REPEATED_STATUS_TURNS = [
	"I read this as continue supervising the portable matrix; it has started cleanly with 1 check green and 8 still pending.",
	"I read this as continue supervising the portable matrix; it has started cleanly with 2 checks green and 7 jobs pending.",
	"I read this as continue supervising the portable matrix; it has started cleanly with 3 checks green and 6 gates pending.",
];

async function runRepetitiveTurnsScenario({ apiName, driveTurn, evidenceSlug, checks, guard, finalMarker, scenarioName }) {
	const { box, server, result } = await driveTurn({
		apiName,
		turns: [
			{ text: REPEATED_STATUS_TURNS[0] },
			{ text: REPEATED_STATUS_TURNS[1] },
			{ text: REPEATED_STATUS_TURNS[2] },
			{ text: finalMarker },
		],
		prompt: `Report status repeatedly and finish with ${finalMarker}.`,
		extraArgs: ["--approve"],
		followUpPrompts: ["continue", "continue"],
		timeoutMs: 180000,
	});

	try {
		const output = `${result.stdout}\n${result.stderr}`;
		const allBodies = JSON.stringify(server.requests.map((r) => r.body ?? r.raw ?? ""));
		checks.ok(`${scenarioName}: CLI exits zero`, result.code === 0 && !result.timedOut, `code=${result.code}`);
		checks.ok(
			`${scenarioName}: cross-turn repetition triggered an extra bounded turn`,
			server.requests.length > 2,
			`requests=${server.requests.length}`,
		);
		checks.ok(
			`${scenarioName}: repetitive-turns system-interrupt injected into a later request`,
			allBodies.includes("repetitive-turns"),
			`interruptPresent=${allBodies.includes("repetitive-turns")}`,
		);
		checks.ok(`${scenarioName}: recovery answer returned`, output.includes(finalMarker), `marker=${finalMarker}`);
		guard.assertUnchanged();
		if (evidenceSlug) writeTtsrEvidence(evidenceSlug, scenarioName, result, server);
	} finally {
		await server.stop();
		box.cleanup();
	}
	process.exit(checks.finish() ? 0 : 1);
}

export async function runTtsrScenario({ scenarioName, apiName, driveTurn, evidenceSlug }) {
	installCleanupHooks();
	const checks = createChecks(`mock-loop.mjs --scenario ${scenarioName} --api ${apiName}`);
	const guard = guardRealAuth();
	const finalMarker = `SENPI-QA-${scenarioName.toUpperCase().replace(/-/g, "_")}-FINAL`;
	if (scenarioName === "ttsr-repetitive-turns") {
		return runRepetitiveTurnsScenario({ apiName, driveTurn, evidenceSlug, checks, guard, finalMarker, scenarioName });
	}
	const collapse = scenarioName === "ttsr-collapse";
	const firstTurn = collapse
		? { reasoning: `analyzing the problem ${"!".repeat(600)}`, chunks: 40 }
		: { reasoning: `Thinking... ${CTRL_SEP} ${CTRL_SEP} ${CTRL_SEP} trailing garbage ${"x".repeat(400)}`, chunks: 20 };
	const { box, server, result } = await driveTurn({
		apiName,
		turns: [firstTurn, { text: finalMarker }],
		prompt: `Analyze briefly and finish with ${finalMarker}.`,
		extraArgs: ["--approve"],
		timeoutMs: 120000,
	});

	try {
		const output = `${result.stdout}\n${result.stderr}`;
		const replayBody = JSON.stringify(server.requests[1]?.body ?? server.requests[1]?.raw ?? "");
		checks.ok(`${scenarioName}: CLI exits zero`, result.code === 0 && !result.timedOut, `code=${result.code}`);
		checks.ok(
			`${scenarioName}: exactly two model turns (abort + one bounded recovery)`,
			server.requests.length === 2,
			`requests=${server.requests.length}`,
		);
		if (collapse) {
			checks.ok(
				"ttsr-collapse: truncated garbage absent from recovery request",
				!BANG_RUN_300.test(replayBody),
				`bangRun300=${BANG_RUN_300.test(replayBody)}`,
			);
		} else {
			checks.ok(
				"ttsr-leak: leaked control tokens absent from retry request",
				!replayBody.includes(CTRL_SEP),
				`sepPresent=${replayBody.includes(CTRL_SEP)}`,
			);
		}
		checks.ok(`${scenarioName}: recovery answer returned`, output.includes(finalMarker), `marker=${finalMarker}`);
		guard.assertUnchanged();
		if (evidenceSlug) writeTtsrEvidence(evidenceSlug, scenarioName, result, server);
	} finally {
		await server.stop();
		box.cleanup();
	}
	process.exit(checks.finish() ? 0 : 1);
}
