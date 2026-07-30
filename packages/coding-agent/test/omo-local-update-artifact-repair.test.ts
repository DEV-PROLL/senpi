import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readStamp, runOmoLocalUpdateBeta, writeStamp } from "../src/beta/omo-local-update.ts";
import { createOmoFixture } from "./omo-local-update-fixture.ts";
import {
	applyOmoGitIsolation,
	createTempRoots,
	installFakeBun,
	makeAgentDir,
	makeLogCollector,
	makeSpyRun,
	withPrependedPath,
} from "./omo-local-update-helpers.ts";

const gitIsolation = applyOmoGitIsolation();
const tempRoots = createTempRoots();

afterAll(() => {
	tempRoots.cleanup();
	gitIsolation.cleanup();
});

describe("OMO local update artifact repair", () => {
	it("rebuilds when a legacy matching stamp omits the missing packaged LSP CLI", { timeout: 90000 }, async () => {
		// given
		const root = tempRoots.makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const { calls, run } = makeSpyRun();
		const options = { env: {}, agentDir, settings: { packages: [fixture.pluginPath] }, run };
		const lspCli = join(fixture.pluginPath, "runtime", "lsp-daemon", "dist", "cli.js");

		try {
			await runOmoLocalUpdateBeta(options);
			const currentStamp = readStamp(agentDir);
			expect(currentStamp).toBeDefined();
			if (currentStamp === undefined) {
				throw new Error("expected the initial update to write a stamp");
			}
			expect(existsSync(lspCli)).toBe(true);
			writeStamp(agentDir, {
				...currentStamp,
				artifacts: currentStamp.artifacts.filter((artifact) => artifact !== "runtime/lsp-daemon/dist/cli.js"),
			});
			rmSync(lspCli);
			calls.length = 0;
			const repair = makeLogCollector();

			// when
			await runOmoLocalUpdateBeta({ ...options, log: repair.log });

			// then
			expect(repair.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
			expect(calls).toContainEqual(["bun", "run", "build:senpi-plugin"]);
			expect(existsSync(lspCli)).toBe(true);
		} finally {
			restorePath();
		}
	});
});
