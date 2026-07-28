import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts/check-upstream-release.mjs");

function runGit(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(cwd, name, content) {
	writeFileSync(path.join(cwd, name), content);
	runGit(cwd, ["add", name]);
	runGit(cwd, ["commit", "-m", `add ${name}`]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

function parseOutput(stdout) {
	return Object.fromEntries(
		stdout
			.trim()
			.split("\n")
			.map((line) => line.split("=", 2)),
	);
}

describe("upstream release detector outputs", () => {
	let root;
	let upstreamWork;
	let upstreamBare;
	let checkout;

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "senpi-upstream-release-"));
		upstreamWork = path.join(root, "upstream-work");
		upstreamBare = path.join(root, "upstream.git");
		checkout = path.join(root, "checkout");

		mkdirSync(upstreamWork);
		runGit(upstreamWork, ["init", "-b", "main"]);
		runGit(upstreamWork, ["config", "user.name", "Test"]);
		runGit(upstreamWork, ["config", "user.email", "test@example.com"]);
		const firstSha = commitFile(upstreamWork, "first.txt", "first");
		runGit(upstreamWork, ["tag", "v1.2.3", firstSha]);
		const releaseSha = commitFile(upstreamWork, "release.txt", "release");
		runGit(upstreamWork, ["tag", "-a", "v1.10.0", "-m", "release", releaseSha]);
		const mainSha = commitFile(upstreamWork, "main.txt", "main");
		runGit(root, ["clone", "--bare", upstreamWork, upstreamBare]);

		mkdirSync(checkout);
		runGit(checkout, ["init", "-b", "main"]);
		runGit(checkout, ["config", "user.name", "Test"]);
		runGit(checkout, ["config", "user.email", "test@example.com"]);
		commitFile(checkout, "local.txt", "local");
		runGit(checkout, ["remote", "add", "upstream", path.join(root, "wrong.git")]);
		runGit(checkout, ["tag", "v1.10.0"]);
		mkdirSync(path.join(checkout, ".github"));
		writeFileSync(path.join(checkout, ".github/upstream.json"), '{"tag":"v1.2.3"}\n');

		assert.equal(runGit(upstreamWork, ["rev-parse", "HEAD"]), mainSha);
		assert.equal(runGit(upstreamWork, ["rev-list", "-n", "1", "v1.10.0"]), releaseSha);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("uses authoritative remote tag and main SHAs without changing remotes or refs", () => {
		const remoteBefore = runGit(checkout, ["remote", "get-url", "upstream"]);
		const stdout = execFileSync("node", [SCRIPT_PATH, "--force"], {
			cwd: checkout,
			encoding: "utf8",
			env: { ...process.env, GITHUB_OUTPUT: "", SENPI_UPSTREAM_REMOTE_URL: upstreamBare },
		});
		const output = parseOutput(stdout);

		assert.equal(output.proceed, "true");
		assert.equal(output.tag, "v1.10.0");
		assert.equal(output.sha, runGit(upstreamWork, ["rev-list", "-n", "1", "v1.10.0"]));
		assert.equal(output.upstream_head_sha, runGit(upstreamWork, ["rev-parse", "main"]));
		assert.equal(output.current_tag, "v1.2.3");
		assert.equal(runGit(checkout, ["remote", "get-url", "upstream"]), remoteBefore);
		assert.equal(runGit(checkout, ["for-each-ref", "--format=%(refname)", "refs/upstream-tags", "refs/remotes/pi-mono"]), "");
		assert.equal(runGit(checkout, ["rev-parse", "v1.10.0"]), runGit(checkout, ["rev-parse", "HEAD"]));
	});

	it("fails closed without trusting a colliding local tag when remote fetch fails", () => {
		const outputPath = path.join(root, "github-output.txt");
		const result = spawnSync("node", [SCRIPT_PATH, "--force"], {
			cwd: checkout,
			encoding: "utf8",
			env: {
				...process.env,
				GITHUB_OUTPUT: outputPath,
				SENPI_UPSTREAM_REMOTE_URL: path.join(root, "missing.git"),
			},
		});

		assert.equal(result.status, 1);
		assert.match(result.stdout, /^proceed=false$/m);
		assert.equal(readFileSync(outputPath, "utf8"), "proceed=false\n");
		assert.equal(runGit(checkout, ["rev-parse", "v1.10.0"]), runGit(checkout, ["rev-parse", "HEAD"]));
	});
});
