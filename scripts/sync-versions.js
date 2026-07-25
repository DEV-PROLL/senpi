#!/usr/bin/env node

/**
 * Synchronizes workspace package dependency versions to source-local workspace versions.
 * Release tooling rewrites publish-only dependency pins immediately before publish.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

const GENERATED_PACKAGE_SUFFIXES = [join("coding-agent", "install-lock")];
const LOCKSTEP_PACKAGE_NAMES = new Set([
	"@code-yeongyu/senpi",
	"@code-yeongyu/senpi-codemode",
	"@code-yeongyu/senpi-server",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-pty",
	"@earendil-works/pi-tui",
	"@earendil-works/pi-web-ui",
]);

const packageRoot = process.argv[2] ?? "packages";
const workspacePackages = findPackageDirectories(packageRoot)
	.filter((directory) => !GENERATED_PACKAGE_SUFFIXES.some((suffix) => directory.endsWith(suffix)))
	.map((directory) => {
		const path = join(directory, "package.json");
		return { data: JSON.parse(readFileSync(path, "utf8")), path };
	});
const versionMap = new Map(workspacePackages.map((pkg) => [pkg.data.name, pkg.data.version]));
const lockstepPackages = workspacePackages.filter((pkg) => LOCKSTEP_PACKAGE_NAMES.has(pkg.data.name));

console.log("Current versions:");
for (const pkg of [...lockstepPackages].sort((a, b) => a.data.name.localeCompare(b.data.name))) {
	console.log(`  ${pkg.data.name}: ${pkg.data.version}`);
}

const lockstepVersions = new Set(lockstepPackages.map((pkg) => pkg.data.version));
if (lockstepVersions.size > 1) {
	console.error("\nERROR: Not all lockstep release packages have the same version.");
	console.error("Expected lockstep versioning. Run one of:");
	console.error("  npm run version:patch");
	console.error("  npm run version:minor");
	console.error("  npm run version:major");
	process.exit(1);
}

console.log("\nAll lockstep release packages are at the same version.");

let totalUpdates = 0;
const updatedPackages = new Set();

function nextWorkspaceVersion(currentSpecifier, nextVersion) {
	if (/^(file|link|workspace):/.test(currentSpecifier) || currentSpecifier.startsWith("npm:")) {
		return null;
	}
	return currentSpecifier.startsWith("^") ? `^${nextVersion}` : nextVersion;
}

for (const pkg of workspacePackages) {
	for (const dependencyType of ["dependencies", "devDependencies"]) {
		const dependencies = pkg.data[dependencyType];
		if (!dependencies) continue;

		for (const [dependencyName, currentSpecifier] of Object.entries(dependencies)) {
			const version = versionMap.get(dependencyName);
			const newSpecifier = version ? nextWorkspaceVersion(currentSpecifier, version) : null;
			if (!newSpecifier || currentSpecifier === newSpecifier) continue;

			console.log(`\n${pkg.data.name}:`);
			console.log(
				`  ${dependencyName}: ${currentSpecifier} -> ${newSpecifier}${dependencyType === "devDependencies" ? " (devDependencies)" : ""}`,
			);
			dependencies[dependencyName] = newSpecifier;
			updatedPackages.add(pkg);
			totalUpdates++;
		}
	}
}

for (const pkg of updatedPackages) {
	writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`);
}

if (totalUpdates === 0) {
	console.log("\nAll inter-package dependencies are already in sync.");
} else {
	console.log(`\nUpdated ${totalUpdates} dependency version(s).`);
}
