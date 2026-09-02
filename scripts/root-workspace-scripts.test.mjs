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
 * The flag-before form (`npm run --workspaces --if-present test`) fans out
 * correctly under both npm and bun, so that is the shape we require here.
 */
const RECURSION_PRONE_FANOUT = /npm run\s+(?!-)[\w:.@/-]+\s+[^&|]*--workspaces?\b/;

test("root workspace fan-out scripts keep --workspaces before the script name", () => {
	const offenders = Object.entries(rootManifest.scripts ?? {})
		.filter(([, body]) => RECURSION_PRONE_FANOUT.test(body))
		.map(([name, body]) => `${name}: ${body}`);

	assert.deepEqual(
		offenders,
		[],
		`These root scripts pass workspace flags after the script name, which recurses under bun.\nMove the flags before the script name (npm run --workspaces --if-present <script>):\n${offenders.join("\n")}`,
	);
});
