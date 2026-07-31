import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadWebsearchConfig } from "../src/core/extensions/builtin/websearch/websearch/config.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

async function loadConfigWithProvider(provider: string, apiKey?: string) {
	const cwd = await makeTempDir("websearch-deepseek-");
	const home = await makeTempDir("websearch-deepseek-home-");
	await mkdir(join(cwd, ".senpi"), { recursive: true });
	const entry: Record<string, unknown> = { provider };
	if (apiKey !== undefined) entry.apiKey = apiKey;
	await writeFile(join(cwd, ".senpi", "websearch.json"), JSON.stringify({ auto: false, providers: [entry] }));
	return loadWebsearchConfig({ cwd, homeDir: home });
}

describe("vendored websearch deepseek provider", () => {
	it("#given a deepseek provider with an api key #when loading the config #then accepts it", async () => {
		// when
		const result = await loadConfigWithProvider("deepseek", "test-key");

		// then
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.providers[0]?.provider).toBe("deepseek");
		}
	});

	it("#given a deepseek provider without an api key #when loading the config #then rejects with missing_api_key", async () => {
		// when
		const result = await loadConfigWithProvider("deepseek");

		// then
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("missing_api_key");
		}
	});
});
