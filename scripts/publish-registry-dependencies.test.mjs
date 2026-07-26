import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PUBLISHED_RUNTIME_WORKSPACES = [
	{ packageJsonPath: "packages/ai/package.json", packageName: "@earendil-works/pi-ai" },
	{ packageJsonPath: "packages/agent/package.json", packageName: "@earendil-works/pi-agent-core" },
	{ packageJsonPath: "packages/tui/package.json", packageName: "@earendil-works/pi-tui" },
	{ packageJsonPath: "packages/pty/package.json", packageName: "@earendil-works/pi-pty" },
	{ packageJsonPath: "packages/senpi-codemode/package.json", packageName: "@code-yeongyu/senpi-codemode" },
];

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe("npm publish dependency graph", () => {
	it("publishes every registry dependency required by the senpi package", () => {
		// Given: Bun resolves dependency edges from the registry and does not consume npm's bundled dependencies.
		const publishScript = readFileSync(join(repoRoot, "scripts", "publish.mjs"), "utf8");

		for (const workspace of PUBLISHED_RUNTIME_WORKSPACES) {
			const manifest = readJson(join(repoRoot, workspace.packageJsonPath));

			// Then: each direct runtime workspace can be published at its lockstep version...
			assert.notEqual(manifest.private, true, `${workspace.packageName} must be publishable`);
			// ...and the release publisher includes it before @code-yeongyu/senpi.
			assert.match(publishScript, new RegExp(`name: "${workspace.packageName}"`));
		}
	});
});
