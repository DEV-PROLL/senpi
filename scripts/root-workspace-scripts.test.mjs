import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

/**
 * Bun rewrites `npm run <name>` to `bun run <name>` inside package.json script
 * text, and bun appends flags placed AFTER the script name to the script itself
 * instead of parsing them as its own flags. A root script shaped like
 * `npm run test --workspaces` therefore re-invokes the ROOT script with the
 * flags appended, growing the command forever instead of fanning out:
 *
 *   bun run test --workspaces --if-present --workspaces --if-present ...
 *
 * Two shapes are safe, and they are NOT interchangeable:
 *
 *   - plural:   `npm run --workspaces --if-present <script>` — bun parses
 *     `--workspaces` as its own flag and fans out natively.
 *   - singular: `npm --workspace=<name> run <script>` — bun does NOT recognize
 *     `--workspace=<name>`, so `npm run --workspace=<name> <script>` STILL
 *     recurses. The flag must sit before `run` so no `npm run` substring is
 *     left for bun to rewrite, keeping the call on real npm.
 *
 * Anything that leaves `npm run` followed by a singular `--workspace` is
 * therefore just as broken as the flag-after-script-name shape.
 */
const FLAG_AFTER_SCRIPT_NAME = /npm run\s+(?!-)[\w:.@/-]+\s+[^&|]*--workspaces?\b/;
const NPM_RUN_WITH_SINGULAR_WORKSPACE = /npm run\s+[^&|]*--workspace(?![s\w])/;

function recursionRisk(body) {
	if (FLAG_AFTER_SCRIPT_NAME.test(body)) return "workspace flag after the script name";
	if (NPM_RUN_WITH_SINGULAR_WORKSPACE.test(body)) return "singular --workspace on an `npm run` call (bun ignores it and re-enters the root script)";
	return undefined;
}

test("root workspace fan-out scripts cannot recurse under bun", () => {
	const offenders = Object.entries(rootManifest.scripts ?? {})
		.map(([name, body]) => ({ name, body, risk: recursionRisk(body) }))
		.filter((entry) => entry.risk !== undefined)
		.map((entry) => `${entry.name}: ${entry.body}  <-- ${entry.risk}`);

	assert.deepEqual(
		offenders,
		[],
		`These root scripts recurse under bun.\nUse \`npm run --workspaces --if-present <script>\` for all-workspace fan-out, or \`npm --workspace=<name> run <script>\` for a single workspace:\n${offenders.join("\n")}`,
	);
});
