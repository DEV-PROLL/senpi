import { describe, expect, it } from "vitest";
import bashTimeoutExtension from "../../src/core/extensions/builtin/bash-timeout/index.ts";
import {
	applyBashTimeout,
	BASH_DEFAULT_TIMEOUT_SECONDS,
	BASH_MAX_TIMEOUT_SECONDS,
	buildBashTimeoutPrompt,
	resolveBashTimeoutDefaults,
	resolveEffectiveBashTimeouts,
} from "../../src/core/extensions/builtin/bash-timeout/timeout.ts";

describe("resolveBashTimeoutDefaults", () => {
	it("returns built-in defaults when env vars are absent", () => {
		const result = resolveBashTimeoutDefaults({});

		expect(result.defaultSeconds).toBe(BASH_DEFAULT_TIMEOUT_SECONDS);
		expect(result.maxSeconds).toBe(BASH_MAX_TIMEOUT_SECONDS);
	});

	it("reads PI_BASH_DEFAULT_TIMEOUT_SECONDS from env", () => {
		const result = resolveBashTimeoutDefaults({ PI_BASH_DEFAULT_TIMEOUT_SECONDS: "30" });

		expect(result.defaultSeconds).toBe(30);
	});

	it("reads PI_BASH_MAX_TIMEOUT_SECONDS from env", () => {
		const result = resolveBashTimeoutDefaults({ PI_BASH_MAX_TIMEOUT_SECONDS: "900" });

		expect(result.maxSeconds).toBe(900);
	});

	it("ignores PI_BASH_DEFAULT_TIMEOUT_SECONDS when value is not a positive integer", () => {
		const garbage = resolveBashTimeoutDefaults({ PI_BASH_DEFAULT_TIMEOUT_SECONDS: "garbage" });
		const zero = resolveBashTimeoutDefaults({ PI_BASH_DEFAULT_TIMEOUT_SECONDS: "0" });
		const negative = resolveBashTimeoutDefaults({ PI_BASH_DEFAULT_TIMEOUT_SECONDS: "-1" });

		expect(garbage.defaultSeconds).toBe(BASH_DEFAULT_TIMEOUT_SECONDS);
		expect(zero.defaultSeconds).toBe(BASH_DEFAULT_TIMEOUT_SECONDS);
		expect(negative.defaultSeconds).toBe(BASH_DEFAULT_TIMEOUT_SECONDS);
	});

	it("ignores PI_BASH_MAX_TIMEOUT_SECONDS when value is not a positive integer", () => {
		const garbage = resolveBashTimeoutDefaults({ PI_BASH_MAX_TIMEOUT_SECONDS: "garbage" });
		const zero = resolveBashTimeoutDefaults({ PI_BASH_MAX_TIMEOUT_SECONDS: "0" });

		expect(garbage.maxSeconds).toBe(BASH_MAX_TIMEOUT_SECONDS);
		expect(zero.maxSeconds).toBe(BASH_MAX_TIMEOUT_SECONDS);
	});

	it("ensures max is at least as large as default when env values would invert that order", () => {
		const result = resolveBashTimeoutDefaults({
			PI_BASH_DEFAULT_TIMEOUT_SECONDS: "500",
			PI_BASH_MAX_TIMEOUT_SECONDS: "100",
		});

		expect(result.defaultSeconds).toBe(500);
		expect(result.maxSeconds).toBe(500);
	});
});

describe("applyBashTimeout", () => {
	const defaults = { defaultSeconds: 120, maxSeconds: 600 };

	it("injects the default timeout when none is provided", () => {
		const input: { command: string; timeout?: number } = { command: "echo hi" };

		const result = applyBashTimeout(input, defaults);

		expect(result).toEqual({ command: "echo hi", timeout: 120 });
	});

	it("preserves a user-supplied timeout below the maximum", () => {
		const input = { command: "sleep 1", timeout: 30 };

		const result = applyBashTimeout(input, defaults);

		expect(result).toEqual({ command: "sleep 1", timeout: 30 });
	});

	it("preserves a user-supplied timeout above the maximum", () => {
		const input = { command: "sleep 99999", timeout: 9999 };

		const result = applyBashTimeout(input, defaults);

		expect(result).toEqual({ command: "sleep 99999", timeout: 9999 });
	});

	it("preserves millisecond-style host timeouts instead of capping them as seconds", () => {
		const input = { command: "sleep 30", timeout: 30_000 };

		const result = applyBashTimeout(input, defaults);

		expect(result).toBe(input);
		expect(result.timeout).toBe(30_000);
	});

	it("treats a non-positive timeout as missing and applies default", () => {
		const zero = applyBashTimeout({ command: "noop", timeout: 0 }, defaults);
		const negative = applyBashTimeout({ command: "noop", timeout: -5 }, defaults);

		expect(zero).toEqual({ command: "noop", timeout: 120 });
		expect(negative).toEqual({ command: "noop", timeout: 120 });
	});

	it("does not mutate the original input object", () => {
		const input: { command: string; timeout?: number } = { command: "echo hi" };

		applyBashTimeout(input, defaults);

		expect(input.timeout).toBeUndefined();
	});
});

describe("buildBashTimeoutPrompt", () => {
	it("includes the resolved default and max in the prompt rider", () => {
		const prompt = buildBashTimeoutPrompt({ defaultSeconds: 120, maxSeconds: 600 });

		expect(prompt).toContain("Default timeout: 120s (2 min)");
		expect(prompt).toContain("Recommended maximum timeout: 600s (10 min)");
	});

	it("falls back to seconds for non-minute-aligned values", () => {
		const prompt = buildBashTimeoutPrompt({ defaultSeconds: 45, maxSeconds: 90 });

		expect(prompt).toContain("Default timeout: 45s (45s)");
		expect(prompt).toContain("Recommended maximum timeout: 90s (90s)");
	});

	it("routes beyond-max workloads to background sessions and monitor, not tmux", () => {
		const prompt = buildBashTimeoutPrompt({ defaultSeconds: 120, maxSeconds: 600 });

		expect(prompt).toContain("run_in_background");
		expect(prompt).toContain("monitor");
		expect(prompt).not.toContain("tmux");
	});
});

describe("resolveEffectiveBashTimeouts", () => {
	const base = { defaultSeconds: 120, maxSeconds: 600 };

	it("leaves the defaults untouched when no cache budget applies", () => {
		const result = resolveEffectiveBashTimeouts(base, undefined);

		expect(result).toEqual({ defaultSeconds: 120, maxSeconds: 600, cacheCapped: false });
	});

	it("caps the recommended maximum at a 270s cache budget while keeping the injected default", () => {
		const result = resolveEffectiveBashTimeouts(base, 270);

		expect(result).toEqual({ defaultSeconds: 120, maxSeconds: 270, cacheCapped: true });
	});

	it("does not cap when the cache budget exceeds the configured maximum", () => {
		const result = resolveEffectiveBashTimeouts(base, 3570);

		expect(result).toEqual({ defaultSeconds: 120, maxSeconds: 600, cacheCapped: false });
	});

	it("pulls the default down with the max when the budget is below it", () => {
		expect(resolveEffectiveBashTimeouts(base, 60)).toEqual({
			defaultSeconds: 60,
			maxSeconds: 60,
			cacheCapped: true,
		});
		expect(resolveEffectiveBashTimeouts(base, 20)).toEqual({
			defaultSeconds: 20,
			maxSeconds: 20,
			cacheCapped: true,
		});
	});

	it("respects env-derived bases as the pre-cap values", () => {
		const envBase = resolveBashTimeoutDefaults({
			PI_BASH_DEFAULT_TIMEOUT_SECONDS: "30",
			PI_BASH_MAX_TIMEOUT_SECONDS: "900",
		});

		expect(resolveEffectiveBashTimeouts(envBase, 270)).toEqual({
			defaultSeconds: 30,
			maxSeconds: 270,
			cacheCapped: true,
		});
	});
});

describe("buildBashTimeoutPrompt cache awareness", () => {
	const LEGACY_PROMPT =
		"\n## Bash Tool Timeout Policy\n\nThe `bash` tool enforces timeouts even when you omit the `timeout` parameter:\n\n- Default timeout: 120s (2 min). Applied automatically when you do not set `timeout`.\n- Recommended maximum timeout: 600s (10 min). Explicit `timeout` values are preserved because different hosts may use different timeout units.\n- For long-running commands (builds, installs, test suites), set an explicit `timeout` that fits the workload. Do not assume commands run forever.\n- For commands that legitimately need to run beyond the recommended maximum, start them with `run_in_background: true` and watch the decisive output with `monitor` instead of raising the timeout.\n";

	it("is byte-identical to the legacy policy when no cache budget applies", () => {
		expect(buildBashTimeoutPrompt({ defaultSeconds: 120, maxSeconds: 600, cacheCapped: false })).toBe(LEGACY_PROMPT);
	});

	it("names the cache-safe ceiling and the prompt-cache reason when capped", () => {
		const prompt = buildBashTimeoutPrompt({ defaultSeconds: 120, maxSeconds: 270, cacheCapped: true });

		expect(prompt).toContain("270s");
		expect(prompt).toMatch(/prompt cache/i);
		expect(prompt).toContain("run_in_background");
		expect(prompt).toContain("monitor");
	});

	it("names a tiny ceiling when the budget collapses default and max together", () => {
		const prompt = buildBashTimeoutPrompt({ defaultSeconds: 20, maxSeconds: 20, cacheCapped: true });

		expect(prompt).toContain("20s");
		expect(prompt).not.toContain("600s");
	});

	it("still accepts the legacy two-field defaults shape", () => {
		expect(buildBashTimeoutPrompt({ defaultSeconds: 120, maxSeconds: 600 })).toBe(LEGACY_PROMPT);
	});
});

describe("bashTimeoutExtension with native Anthropic bash active", () => {
	it("keeps the legacy policy when the PTY bash tool has stepped aside", async () => {
		const previous = process.env.PI_ANTHROPIC_BASH;
		process.env.PI_ANTHROPIC_BASH = "1";
		try {
			const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
			const pi = {
				on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
					handlers.set(name, handler);
				},
			};
			bashTimeoutExtension(pi as never);

			const ctx = {
				model: { api: "anthropic-messages" },
				getPromptCacheSafeWaitSeconds: () => 270,
			};
			const result = (await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, ctx)) as {
				systemPrompt: string;
			};

			expect(result.systemPrompt).toBe(`BASE${buildBashTimeoutPrompt({ defaultSeconds: 120, maxSeconds: 600 })}`);
		} finally {
			if (previous === undefined) delete process.env.PI_ANTHROPIC_BASH;
			else process.env.PI_ANTHROPIC_BASH = previous;
		}
	});

	it("still caps the ceiling when native Anthropic bash is not active", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
				handlers.set(name, handler);
			},
		};
		bashTimeoutExtension(pi as never);

		const ctx = { model: { api: "anthropic-messages" }, getPromptCacheSafeWaitSeconds: () => 270 };
		const result = (await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, ctx)) as {
			systemPrompt: string;
		};

		expect(result.systemPrompt).toContain("270s");
	});
});
