#!/usr/bin/env node

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rewritePublishManifest } from "./publish-manifest.mjs";

describe("publish manifest rewrite", () => {
	it("targets the Senpi fork for OIDC provenance", () => {
		const manifest = {
			name: "@earendil-works/pi-ai",
			private: true,
			repository: "git+https://github.com/earendil-works/pi.git",
		};

		rewritePublishManifest(manifest, {
			directory: "packages/ai",
			name: "@code-yeongyu/senpi-ai",
		});

		assert.deepEqual(manifest, {
			name: "@code-yeongyu/senpi-ai",
			repository: {
				type: "git",
				url: "git+https://github.com/code-yeongyu/senpi.git",
				directory: "packages/ai",
			},
		});
	});
});
