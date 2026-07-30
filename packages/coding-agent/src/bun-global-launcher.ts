import { dirname, join } from "node:path";

export interface BunLauncherRepairCommand {
	readonly command: string;
	readonly args: string[];
	readonly display: string;
}

const BUN_LAUNCHER_REPAIR_SOURCE = `
import { renameSync, writeFileSync } from "node:fs";
const [launcher, entrypoint] = process.argv.slice(1);
if (!launcher || !entrypoint) throw new Error("Missing Bun launcher repair path");
const quote = (value) => "'" + value.replaceAll("'", "'\\"'\\"'") + "'";
const temporary = launcher + "." + process.pid + ".tmp";
writeFileSync(temporary, "#!/bin/sh\\nexec " + quote(process.execPath) + " " + quote(entrypoint) + " \\"$@\\"\\n", { mode: 0o755 });
renameSync(temporary, launcher);
`.trim();

export function createBunLauncherRepairCommand(
	binDir: string,
	packageName: string,
	executableName: string,
): BunLauncherRepairCommand {
	const packageDir = join(dirname(binDir), "install", "global", "node_modules", ...packageName.split("/"));
	const launcher = join(binDir, executableName);
	const entrypoint = join(packageDir, "dist", "cli.js");
	return {
		command: "bun",
		args: ["-e", BUN_LAUNCHER_REPAIR_SOURCE, launcher, entrypoint],
		display: `repair Bun launcher ${launcher}`,
	};
}
