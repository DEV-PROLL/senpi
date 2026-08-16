/**
 * Real RPC proof for dollar skill expansion, typed invocation events, and MCP
 * loaded-surface stability.
 *
 * Run:
 *   node .agents/skills/senpi-qa/scripts/scenarios/dollar-skill-invocation-qa.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { TargetRpcClient } from "../lib/target-rpc-client.mjs";

const label = "dollar-skill-invocation";
const root = repoRoot();
const checks = createChecks("dollar-skill-invocation-qa.mjs");
const guard = guardRealAuth();
const box = makeSandbox(label);
const evidence = evidenceDir(label);
const server = await startFakeModelServer({ turns: [{ text: "DOLLAR_SKILL_QA_OK" }] });
writeMockModelsJson(box.agentDir, server, "anthropic-messages");

const skillDir = join(box.cwd, "debugging");
const skillPath = join(skillDir, "SKILL.md");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
	skillPath,
	"---\nname: debugging\ndescription: Debug runtime failures\n---\n\n# Debugging\n\nTrace the defect before proposing a fix.",
);

const client = new TargetRpcClient({
	env: hermeticEnv(box.env),
	cwd: box.cwd,
	targetRoot: root,
	extraArgs: ["--skill", skillDir],
});

installCleanupHooks();
try {
	await client.send({ type: "set_model", provider: "anthropic", modelId: "mock-claude" });
	const before = await client.send({ type: "get_loaded_surfaces" });
	const invocationPromise = client.waitFor((event) => event.message.type === "skill_invocation");
	const settledPromise = client.waitFor((event) => event.message.type === "agent_settled");

	const prompt = "Use $skill:debugging to inspect $HOME safely";
	const accepted = await client.send({ type: "prompt", message: prompt });
	const invocation = (await invocationPromise).message;
	await settledPromise;
	const after = await client.send({ type: "get_loaded_surfaces" });

	const request = server.requests.find((entry) => entry.method === "POST" && entry.url?.includes("/messages"));
	const requestText = JSON.stringify(request?.messages ?? []);
	checks.ok("prompt accepted", accepted.success === true, JSON.stringify(accepted));
	checks.ok(
		"ordered dollar invocation event",
		invocation.type === "skill_invocation" &&
			Array.isArray(invocation.skills) &&
			invocation.skills.length === 1 &&
			invocation.skills[0]?.name === "debugging" &&
			invocation.skills[0]?.path === skillPath &&
			invocation.skills[0]?.syntax === "dollar",
		JSON.stringify(invocation),
	);
	checks.ok("skill instruction reached provider", requestText.includes('name=\\"debugging\\"'), requestText.slice(0, 800));
	checks.ok(
		"explicit token removed and ordinary dollar prose preserved",
		!requestText.includes("$skill:debugging") && requestText.includes("$HOME"),
		requestText.slice(0, 800),
	);
	checks.ok(
		"MCP loaded surfaces unchanged",
		JSON.stringify(before.data?.mcpServers ?? []) === JSON.stringify(after.data?.mcpServers ?? []),
		JSON.stringify({ before: before.data?.mcpServers, after: after.data?.mcpServers }),
	);
	checks.ok("real auth unchanged", guard.assertUnchanged(), guard.path);

	writeFileSync(
		join(evidence, "rpc-dollar-skill-invocation.json"),
		JSON.stringify(
			{
				prompt,
				accepted,
				invocation,
				beforeMcpServers: before.data?.mcpServers ?? [],
				afterMcpServers: after.data?.mcpServers ?? [],
				providerRequestMessages: request?.messages ?? [],
				stderrTail: client.stderr.slice(-2_000),
			},
			null,
			2,
		),
	);
	process.stderr.write(`evidence: ${evidence}\n`);
} finally {
	await client.close();
	await server.stop();
	box.cleanup();
}

process.exit(checks.finish() ? 0 : 1);
