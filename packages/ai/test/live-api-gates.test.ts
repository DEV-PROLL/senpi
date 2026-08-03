import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getLiveEnvApiKey,
	isOllamaLiveTestAvailable,
	LOCAL_LLM_LIVE_TEST_FLAG,
	OPENROUTER_LIVE_TEST_FLAG,
} from "./live-api-gates.ts";

const execSync = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({ execSync }));

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

	it("given no live opt-in env vars when checking Ollama then does not probe", () => {
		// given
		vi.stubEnv(LOCAL_LLM_LIVE_TEST_FLAG, undefined);
		vi.stubEnv("PI_ENABLE_LIVE_API_TESTS", undefined);

		// when
		const available = isOllamaLiveTestAvailable();

		// then
		expect(available).toBe(false);
		expect(execSync).not.toHaveBeenCalled();
	});

	it("given local LLM opt-in on Unix when checking Ollama then uses which", () => {
		// given
		vi.stubEnv(LOCAL_LLM_LIVE_TEST_FLAG, "1");
		vi.stubEnv("PI_ENABLE_LIVE_API_TESTS", undefined);

		// when
		const available = isOllamaLiveTestAvailable("linux");

		// then
		expect(available).toBe(true);
		expect(execSync).toHaveBeenCalledOnce();
		expect(execSync).toHaveBeenCalledWith("which ollama", { stdio: "ignore" });
	});

	it("given global live opt-in on Windows when checking Ollama then uses where", () => {
		// given
		vi.stubEnv(LOCAL_LLM_LIVE_TEST_FLAG, undefined);
		vi.stubEnv("PI_ENABLE_LIVE_API_TESTS", "1");

		// when
		const available = isOllamaLiveTestAvailable("win32");

		// then
		expect(available).toBe(true);
		expect(execSync).toHaveBeenCalledOnce();
		expect(execSync).toHaveBeenCalledWith("where ollama", { stdio: "ignore" });
	});
});
