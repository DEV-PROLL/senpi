/**
 * Declare and verify this suite's workspace-build prerequisite.
 *
 * Vitest resolves `@earendil-works/pi-ai` / `pi-tui` / `pi-agent-core` to the
 * sibling packages' TypeScript sources via the aliases in `vitest.base.ts`, so
 * in-process tests never need a build. The CHILD PROCESSES do: the spawned CLI
 * (`src/cli.ts` under tsx) and the worker fixtures resolve those same
 * specifiers through Node, which honours each manifest's `exports` map and
 * therefore requires the built `dist/*` entrypoints.
 *
 * When they are absent, the child dies during import — before reaching any
 * behavior under test — and the parent test reports only its downstream
 * symptom (`expected 1 to be +0`, an empty stdout, a missing log line). That
 * failure mode is unattributable at the assertion site, which is why this
 * check runs once per worker in the global setup and names the prerequisite
 * plus the exact command that satisfies it. CI already runs `npm run build`
 * before the test shards (`.github/workflows/ci.yml`); this makes the same
 * requirement explicit and self-diagnosing for local runs.
 *
 * Resolution goes through `import.meta.resolve`, not `require.resolve`: these
 * manifests export only the `import` condition, so a CJS-conditioned probe
 * would report a false negative for every specifier. Because
 * `import.meta.resolve` is spec-compliant and does not touch the filesystem,
 * the resolved target is then stat-ed — resolving a path proves the `exports`
 * map, not the build.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Specifiers that child processes resolve through Node's `exports` maps. */
const CHILD_PROCESS_SPECIFIERS = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/compat",
	"@earendil-works/pi-tui",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-agent-core/node",
] as const;

/**
 * Returns the specifiers whose built entrypoint cannot be resolved from
 * `parentUrl`. Resolution goes through Node's own ESM resolver rather than a
 * hardcoded `dist/index.js` guess, so this asserts exactly what an ESM child
 * process will do.
 */
export function findUnbuiltWorkspaceSpecifiers(parentUrl: string): string[] {
	const missing: string[] = [];
	for (const specifier of CHILD_PROCESS_SPECIFIERS) {
		try {
			if (!existsSync(fileURLToPath(import.meta.resolve(specifier, parentUrl)))) missing.push(specifier);
		} catch {
			missing.push(specifier);
		}
	}
	return missing;
}

/** Throws an actionable error when the workspace build prerequisite is unmet. */
export function assertWorkspaceBuildPrerequisite(parentUrl: string): void {
	const missing = findUnbuiltWorkspaceSpecifiers(parentUrl);
	if (missing.length === 0) return;
	throw new Error(
		`Unmet test prerequisite: the workspace packages are not built, so child-process tests ` +
			`(spawned CLI, worker fixtures) cannot resolve ${missing.join(", ")}. ` +
			`Run \`npm run build\` from the repository root, then re-run this suite.`,
	);
}
