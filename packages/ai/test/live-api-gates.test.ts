import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getLiveEnvApiKey,
	isOllamaLiveTestAvailable,
	LOCAL_LLM_LIVE_TEST_FLAG,
	OPENROUTER_LIVE_TEST_FLAG,
} from "./live-api-gates.ts";

const execSync = vi.hoisted(() => vi.fn());

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("child_process")>()),
	execSync,
}));

describe("live API test gates", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it("given ambient OpenRouter key without opt-in when resolving live key then skips it", () => {
		// given
		vi.stubEnv("OPENROUTER_API_KEY", "sk-or-stale");
		vi.stubEnv(OPENROUTER_LIVE_TEST_FLAG, "");
		vi.stubEnv("PI_ENABLE_LIVE_API_TESTS", "");

		// when
		const apiKey = getLiveEnvApiKey("OPENROUTER_API_KEY", OPENROUTER_LIVE_TEST_FLAG);

		// then
		expect(apiKey).toBeUndefined();
	});

	it("given ambient OpenRouter key with provider opt-in when resolving live key then returns it", () => {
		// given
		vi.stubEnv("OPENROUTER_API_KEY", "sk-or-live");
		vi.stubEnv(OPENROUTER_LIVE_TEST_FLAG, "1");
		vi.stubEnv("PI_ENABLE_LIVE_API_TESTS", "");

		// when
		const apiKey = getLiveEnvApiKey("OPENROUTER_API_KEY", OPENROUTER_LIVE_TEST_FLAG);

		// then
		expect(apiKey).toBe("sk-or-live");
	});

	it("given ambient OpenRouter key with global opt-in when resolving live key then returns it", () => {
		// given
		vi.stubEnv("OPENROUTER_API_KEY", "sk-or-global");
		vi.stubEnv(OPENROUTER_LIVE_TEST_FLAG, "");
		vi.stubEnv("PI_ENABLE_LIVE_API_TESTS", "1");

		// when
		const apiKey = getLiveEnvApiKey("OPENROUTER_API_KEY", OPENROUTER_LIVE_TEST_FLAG);

		// then
		expect(apiKey).toBe("sk-or-global");
	});

	it("given local LLM server without opt-in when checking live tests then disables local probing", () => {
		// given
		vi.stubEnv("PI_NO_LOCAL_LLM", "");
		vi.stubEnv(LOCAL_LLM_LIVE_TEST_FLAG, "");
		vi.stubEnv("PI_ENABLE_LIVE_API_TESTS", "");

		// when
		const available = isOllamaLiveTestAvailable();

		// then
		expect(available).toBe(false);
		expect(execSync).not.toHaveBeenCalled();
	});

	it("given local LLM opt-in when checking live tests then enables local probing", () => {
		// given
		vi.stubEnv(LOCAL_LLM_LIVE_TEST_FLAG, "1");
		vi.stubEnv("PI_ENABLE_LIVE_API_TESTS", "");

		// when
		const available = isOllamaLiveTestAvailable();

		// then
		expect(available).toBe(true);
		expect(execSync).toHaveBeenCalledWith("which ollama", { stdio: "ignore" });
	});

	it("given global live opt-in when checking live tests then enables local probing", () => {
		// given
		vi.stubEnv(LOCAL_LLM_LIVE_TEST_FLAG, "");
		vi.stubEnv("PI_ENABLE_LIVE_API_TESTS", "1");

		// when
		const available = isOllamaLiveTestAvailable();

		// then
		expect(available).toBe(true);
		expect(execSync).toHaveBeenCalledWith("which ollama", { stdio: "ignore" });
	});
});
