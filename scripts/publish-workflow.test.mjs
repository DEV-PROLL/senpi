#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
const codingAgentPackage = JSON.parse(
	readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"),
);

describe("publish-only workflow", () => {
	it("reuses the release validation instead of rerunning the full suite", () => {
		const publishStep = workflow.match(/- name: Publish prepared version[\s\S]*?(?=\n      - name: Workflow summary)/)?.[0];
		assert.ok(publishStep, "expected publish-only step");
		assert.match(publishStep, /node scripts\/publish\.mjs/);
		assert.doesNotMatch(publishStep, /npm run check|npm test/);
	});

	it("keeps binary package scripts shell-executable", () => {
		assert.doesNotMatch(codingAgentPackage.scripts["copy-binary-assets"], /&&\s*&&/);
	});
});
