#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildPublishArgs } from "./publish-command.mjs";

describe("npm publish command", () => {
	it("routes root publish scripts through the guarded publisher", () => {
		const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		assert.equal(rootPackage.scripts.publish, "npm run prepublishOnly && node scripts/publish.mjs");
		assert.equal(rootPackage.scripts["publish:dry"], "npm run prepublishOnly && node scripts/publish.mjs --dry-run");
	});

	it("rejects release publication outside GitHub Actions", () => {
		assert.throws(
			() => buildPublishArgs({ githubActions: false }),
			/GitHub Actions is required for provenance-backed npm publication/,
		);
	});

	it("uses provenance inside GitHub Actions", () => {
		assert.deepEqual(buildPublishArgs({ githubActions: true }), [
			"publish",
			"--access",
			"public",
			"--tag",
			"latest",
			"--provenance",
			"--ignore-scripts",
		]);
	});
});
