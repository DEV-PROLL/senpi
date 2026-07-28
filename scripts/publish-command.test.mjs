#!/usr/bin/env node

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPublishArgs } from "./publish-command.mjs";

describe("npm publish command", () => {
	it("uses provenance only inside GitHub Actions", () => {
		assert.deepEqual(buildPublishArgs({ githubActions: false }), [
			"publish",
			"--access",
			"public",
			"--tag",
			"latest",
			"--ignore-scripts",
		]);
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
