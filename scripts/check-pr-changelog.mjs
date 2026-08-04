#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Release-managed packages (see .github/agent/commands/cl.md). Runtime source
// changes under these trees must ship a CHANGELOG.md [Unreleased] entry in the
// same PR, unless the PR carries the `no-changelog` label.
const RELEASE_MANAGED_PACKAGES = ["ai", "agent", "coding-agent", "tui", "pty", "senpi-codemode"];
const RUNTIME_SOURCE_PATTERN = new RegExp(`^packages/(?:${RELEASE_MANAGED_PACKAGES.join("|")})/src/`);
const CRATES_SOURCE_PATTERN = /^crates\/senpi-pty\//;
const CHANGELOG_PATTERN = /(^|\/)CHANGELOG\.md$/i;
const NO_CHANGELOG_LABEL = "no-changelog";

// Generated model catalogs are excluded from changelog audits per cl.md unless
// accompanied by an intentional product-facing change.
const GENERATED_CATALOG_FILES = new Set([
	"packages/ai/src/models.generated.ts",
	"packages/ai/src/image-models.generated.ts",
]);

function isTestFile(path) {
	return /(^|\/)(__tests__|tests?)\//.test(path) || /\.(test|spec)(-d)?\.[cm]?[jt]sx?$/.test(path);
}

function isDocsFile(path) {
	return /\.(md|mdx)$/i.test(path);
}

export function isRuntimeSourceChange(path) {
	if (GENERATED_CATALOG_FILES.has(path)) {
		return false;
	}
	if (isTestFile(path) || isDocsFile(path)) {
		return false;
	}
	return RUNTIME_SOURCE_PATTERN.test(path) || CRATES_SOURCE_PATTERN.test(path);
}

export function isChangelogChange(path) {
	return CHANGELOG_PATTERN.test(path);
}

export function checkPrChangelog({ changedFiles, labels }) {
	const normalizedLabels = labels.map((label) => label.trim()).filter(Boolean);
	const hasNoChangelogLabel = normalizedLabels.includes(NO_CHANGELOG_LABEL);
	const changelogFiles = changedFiles.filter(isChangelogChange);
	const runtimeFiles = changedFiles.filter(isRuntimeSourceChange);

	let pass;
	let reason;
	if (runtimeFiles.length === 0) {
		pass = true;
		reason = "no runtime source changes detected";
	} else if (changelogFiles.length > 0) {
		pass = true;
		reason = `changelog entry updated (${changelogFiles.join(", ")})`;
	} else if (hasNoChangelogLabel) {
		pass = true;
		reason = `'${NO_CHANGELOG_LABEL}' label present`;
	} else {
		pass = false;
		reason = "runtime source changed without a CHANGELOG.md entry";
	}

	return { pass, reason, runtimeFiles, changelogFiles, hasNoChangelogLabel };
}

function parseArgs(argv) {
	const args = { labels: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--base") {
			args.base = argv[index + 1];
			index += 1;
		} else if (arg === "--labels") {
			args.labels = (argv[index + 1] ?? "")
				.split(",")
				.map((label) => label.trim())
				.filter(Boolean);
			index += 1;
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	if (!args.base) {
		throw new Error("missing required --base <sha> argument");
	}
	return args;
}

function listChangedFiles(base) {
	const result = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], {
		encoding: "utf8",
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`git diff --name-only ${base}...HEAD failed:\n${result.stderr.trim()}`);
	}
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

export function main(argv) {
	let args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		console.error(`changelog-gate: ERROR - ${error.message}`);
		console.error("usage: node scripts/check-pr-changelog.mjs --base <sha> [--labels a,b,c]");
		return 1;
	}

	let changedFiles;
	try {
		changedFiles = listChangedFiles(args.base);
	} catch (error) {
		console.error(`changelog-gate: ERROR - ${error.message}`);
		return 1;
	}

	const result = checkPrChangelog({ changedFiles, labels: args.labels });
	const verdict = result.pass ? "PASS" : "FAIL";
	console.log(`changelog-gate: ${verdict} - ${result.reason}`);
	if (!result.pass) {
		for (const file of result.runtimeFiles) {
			console.log(`  runtime change: ${file}`);
		}
		console.log(
			"Add an entry under ## [Unreleased] in the affected package CHANGELOG.md, " +
				`or apply the '${NO_CHANGELOG_LABEL}' label if this change is not user-facing.`,
		);
	}
	return result.pass ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	process.exit(main(process.argv.slice(2)));
}
