#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");

describe("binary release workflow", () => {
	it("pins a stable Bun release with downloadable cross-compile executables", () => {
		assert.match(workflow, /bun-version:\s*['"]1\.3\.14['"]/);
		assert.doesNotMatch(workflow, /bun-version:\s*canary/);
		assert.doesNotMatch(workflow, /assert-bun-canary\.sh/);
	});

	it("keeps recovery source refs separate from the published release tag", () => {
		assert.match(workflow, /RELEASE_TAG:\s*\$\{\{ github\.event\.inputs\.tag \|\| github\.ref_name \}\}/);
		assert.match(
			workflow,
			/SOURCE_REF:\s*\$\{\{ github\.event\.inputs\.source_ref \|\| github\.event\.inputs\.tag \|\| github\.ref_name \}\}/,
		);
	});
});
