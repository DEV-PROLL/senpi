import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prepareAssetsScript = join(repoRoot, "scripts", "prepare-bun-compile-assets.mjs");
let tempDir;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function writeFixture(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function writeJsdomFixture(root, stylesheet) {
	const jsdomRoot = join(root, "node_modules", "jsdom");
	writeFixture(join(jsdomRoot, "lib", "jsdom", "browser", "default-stylesheet.css"), stylesheet);
	writeFixture(
		join(jsdomRoot, "lib", "jsdom", "living", "css", "helpers", "computed-style.js"),
		`"use strict";\n\nconst fs = require("node:fs");\nconst path = require("node:path");\n\nconst defaultStyleSheet = fs.readFileSync(\n  path.resolve(__dirname, "../../../browser/default-stylesheet.css"),\n  { encoding: "utf-8" }\n);\n`,
	);
	return join(jsdomRoot, "lib", "jsdom", "living", "css", "helpers", "computed-style.js");
}

function writeJsdomXhrFixture(root) {
	const xhrRoot = join(root, "node_modules", "jsdom", "lib", "jsdom", "living", "xhr");
	writeFixture(join(xhrRoot, "xhr-sync-worker.js"), `"use strict";\n`);
	const xhrImplementationPath = join(xhrRoot, "XMLHttpRequest-impl.js");
	writeFixture(
		xhrImplementationPath,
		`"use strict";\n\nconst syncWorkerFile = require.resolve("./xhr-sync-worker.js");\n`,
	);
	return xhrImplementationPath;
}

describe("prepare-bun-compile-assets", () => {
	it("inlines jsdom's default stylesheet for Bun-compiled binaries", () => {
		// Given: jsdom loads this stylesheet through an absolute filesystem path at runtime.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bun-compile-assets-"));
		const stylesheet = "html { color: red; }\n";
		const computedStylePath = writeJsdomFixture(tempDir, stylesheet);

		// When
		const result = spawnSync(process.execPath, [prepareAssetsScript], {
			cwd: tempDir,
			encoding: "utf8",
		});

		// Then: the compiled module no longer requires the filesystem-only CSS asset.
		assert.equal(result.status, 0, result.stderr);
		const preparedSource = readFileSync(computedStylePath, "utf8");
		assert.match(preparedSource, /const defaultStyleSheet = "html \{ color: red; \}\\n";/);
		assert.doesNotMatch(preparedSource, /default-stylesheet\.css/);

		// And: rebuilds invoke this preparation step again without restoring node_modules.
		const repeatedResult = spawnSync(process.execPath, [prepareAssetsScript], {
			cwd: tempDir,
			encoding: "utf8",
		});
		assert.equal(repeatedResult.status, 0, repeatedResult.stderr);
		assert.equal(readFileSync(computedStylePath, "utf8"), preparedSource);
	});

	it("rewrites jsdom's sync worker lookup for Bun standalone binaries", () => {
		// Given: jsdom eagerly resolves the worker to the build machine's absolute checkout path.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bun-compile-assets-"));
		writeJsdomFixture(tempDir, "html { color: red; }\n");
		const xhrImplementationPath = writeJsdomXhrFixture(tempDir);

		// When
		const result = spawnSync(process.execPath, [prepareAssetsScript], {
			cwd: tempDir,
			encoding: "utf8",
		});

		// Then: Bun can map the relative worker URL to its separately embedded entrypoint.
		assert.equal(result.status, 0, result.stderr);
		const preparedSource = readFileSync(xhrImplementationPath, "utf8");
		assert.match(
			preparedSource,
			/const syncWorkerFile = new URL\("\.\/xhr-sync-worker\.js", import\.meta\.url\);/,
		);
		assert.doesNotMatch(preparedSource, /require\.resolve\("\.\/xhr-sync-worker\.js"\)/);

		const repeatedResult = spawnSync(process.execPath, [prepareAssetsScript], {
			cwd: tempDir,
			encoding: "utf8",
		});
		assert.equal(repeatedResult.status, 0, repeatedResult.stderr);
		assert.equal(readFileSync(xhrImplementationPath, "utf8"), preparedSource);
	});
});
