import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const syncVersionsScript = fileURLToPath(new URL("./sync-versions.js", import.meta.url));

async function writeManifest(root, relativeDirectory, manifest) {
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function readManifest(root, relativeDirectory) {
	return JSON.parse(await readFile(join(root, relativeDirectory, "package.json"), "utf8"));
}

function runSyncVersions(root) {
	return spawnSync(process.execPath, [syncVersionsScript, join(root, "packages")], {
		cwd: root,
		encoding: "utf8",
	});
}

test("keeps senpi source dependencies on local workspace versions", async () => {
	const root = await mkdtemp(join(tmpdir(), "senpi-sync-versions-"));
	try {
		await writeManifest(root, "packages/agent", {
			name: "@earendil-works/pi-agent-core",
			private: true,
			version: "2026.5.19",
		});
		await writeManifest(root, "packages/ai", {
			name: "@earendil-works/pi-ai",
			private: true,
			version: "2026.5.19",
		});
		await writeManifest(root, "packages/tui", {
			name: "@earendil-works/pi-tui",
			private: true,
			version: "2026.5.19",
		});
		await writeManifest(root, "packages/pty", {
			name: "@earendil-works/pi-pty",
			private: true,
			version: "2026.5.19",
		});
		await writeManifest(root, "packages/coding-agent", {
			name: "@code-yeongyu/senpi",
			version: "2026.5.19",
			dependencies: {
				"@earendil-works/pi-agent-core": "^0.74.0",
				"@earendil-works/pi-ai": "^0.74.0",
				"@earendil-works/pi-pty": "^0.74.0",
				"@earendil-works/pi-tui": "^0.74.0",
			},
		});

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);

		const senpiPackage = await readManifest(root, "packages/coding-agent");
		assert.deepEqual(senpiPackage.dependencies, {
			"@earendil-works/pi-agent-core": "^2026.5.19",
			"@earendil-works/pi-ai": "^2026.5.19",
			"@earendil-works/pi-pty": "^2026.5.19",
			"@earendil-works/pi-tui": "^2026.5.19",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("synchronizes private dependencies without touching registry aliases, generated manifests, or published lockstep", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-sync-versions-"));
	try {
		await writeManifest(root, "packages/ai", {
			name: "@earendil-works/pi-ai",
			version: "2.0.0",
		});
		await writeManifest(root, "packages/coding-agent", {
			name: "@code-yeongyu/senpi",
			version: "2.0.0",
		});
		await writeManifest(root, "packages/storage/sqlite-node", {
			name: "@earendil-works/pi-storage-sqlite-node",
			version: "0.82.1",
			dependencies: {
				"@earendil-works/pi-ai": "^0.82.1",
				"@earendil-works/pi-agent-core": "file:../../agent",
			},
		});
		await writeManifest(root, "packages/evals", {
			name: "@earendil-works/pi-evals",
			version: "9.9.9",
			private: true,
			dependencies: {
				"@code-yeongyu/senpi": "^1.0.0",
				"@mariozechner/pi-ai": "npm:@earendil-works/pi-ai@1.0.0",
			},
		});
		await writeManifest(root, "packages/coding-agent/install-lock", {
			name: "generated-install-lock",
			version: "0.0.0",
			private: true,
			dependencies: {
				"@code-yeongyu/senpi": "^1.0.0",
			},
		});

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);

		const evalsManifest = await readManifest(root, "packages/evals");
		assert.equal(evalsManifest.dependencies["@code-yeongyu/senpi"], "^2.0.0");
		assert.equal(evalsManifest.dependencies["@mariozechner/pi-ai"], "npm:@earendil-works/pi-ai@1.0.0");
		const storageManifest = await readManifest(root, "packages/storage/sqlite-node");
		assert.equal(storageManifest.dependencies["@earendil-works/pi-ai"], "^2.0.0");
		assert.equal(storageManifest.dependencies["@earendil-works/pi-agent-core"], "file:../../agent");
		const generatedManifest = await readManifest(root, "packages/coding-agent/install-lock");
		assert.equal(generatedManifest.dependencies["@code-yeongyu/senpi"], "^1.0.0");

		await writeManifest(root, "packages/ai", {
			name: "@earendil-works/pi-ai",
			version: "3.0.0",
		});
		const lockstepFailure = runSyncVersions(root);
		assert.equal(lockstepFailure.status, 1, lockstepFailure.stderr);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
