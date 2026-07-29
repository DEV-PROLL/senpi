import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import {
	getFromSourceRealConfigWarning,
	isFromSourceRun,
	targetsRealUserAgentDir,
} from "../src/from-source-config-guard.ts";

const HOME = "/home/qa-user";
const REAL_AGENT_DIR = join(HOME, CONFIG_DIR_NAME, "agent");

describe("isFromSourceRun", () => {
	it("#given a ts module url and no bun binary #then it is a from-source run", () => {
		expect(isFromSourceRun("file:///repo/src/from-source-config-guard.ts", false)).toBe(true);
	});

	it("#given a bundled js module url #then it is not a from-source run", () => {
		expect(isFromSourceRun("file:///opt/senpi/dist/from-source-config-guard.js", false)).toBe(false);
	});

	it("#given a bun binary #then it is never a from-source run", () => {
		expect(isFromSourceRun("file:///repo/src/from-source-config-guard.ts", true)).toBe(false);
	});
});

describe("targetsRealUserAgentDir", () => {
	it("#given the real home agent dir and no env override #then it targets real config", () => {
		expect(targetsRealUserAgentDir(REAL_AGENT_DIR, "", HOME)).toBe(true);
	});

	it("#given an env override #then it does not target real config", () => {
		expect(targetsRealUserAgentDir(REAL_AGENT_DIR, "/tmp/sandbox/agent", HOME)).toBe(false);
	});

	it("#given a non-home agent dir #then it does not target real config", () => {
		expect(targetsRealUserAgentDir("/tmp/sandbox/agent", "", HOME)).toBe(false);
	});
});

describe("getFromSourceRealConfigWarning", () => {
	const TS_URL = "file:///repo/src/from-source-config-guard.ts";

	it("#given a from-source run against real config #then it returns an isolation warning", () => {
		const warning = getFromSourceRealConfigWarning(REAL_AGENT_DIR, TS_URL, "", HOME, false);
		expect(warning).toContain("running from source against the real user config");
		expect(warning).toContain(ENV_AGENT_DIR);
		expect(warning).toContain(REAL_AGENT_DIR);
	});

	it("#given an isolated env override #then it stays silent", () => {
		expect(getFromSourceRealConfigWarning(REAL_AGENT_DIR, TS_URL, "/tmp/sandbox/agent", HOME, false)).toBeUndefined();
	});

	it("#given a bundled or bun-binary run #then it stays silent", () => {
		expect(
			getFromSourceRealConfigWarning(REAL_AGENT_DIR, "file:///opt/dist/guard.js", "", HOME, false),
		).toBeUndefined();
		expect(getFromSourceRealConfigWarning(REAL_AGENT_DIR, TS_URL, "", HOME, true)).toBeUndefined();
	});
});
