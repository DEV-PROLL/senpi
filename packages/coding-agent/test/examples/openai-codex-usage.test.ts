import { describe, expect, it } from "vitest";

import {
	codexUsageStatusText,
	fetchCodexUsage,
	formatCodexUsage,
	parseCodexUsage,
	startCodexUsagePolling,
} from "../../examples/extensions/openai-codex-usage/codex-usage.ts";
import { shouldLoadCodexUsage } from "../../examples/extensions/openai-codex-usage/index.ts";

describe("shouldLoadCodexUsage", () => {
	it("requires UI, the Codex provider, and OAuth", () => {
		expect(shouldLoadCodexUsage("openai-codex", true, true)).toBe(true);
		expect(shouldLoadCodexUsage("openai-codex", false, true)).toBe(false);
		expect(shouldLoadCodexUsage("openai-codex", true, false)).toBe(false);
		expect(shouldLoadCodexUsage("anthropic", true, true)).toBe(false);
	});
});

describe("parseCodexUsage", () => {
	it("selects limits by window duration when slots are reversed", () => {
		const usage = parseCodexUsage({
			rate_limit: {
				primary_window: {
					used_percent: 25,
					limit_window_seconds: 604_800,
				},
				secondary_window: {
					used_percent: 40,
					limit_window_seconds: 18_000,
				},
			},
		});

		expect(usage).toEqual({
			fiveHourRemainingPercent: 60,
			weeklyRemainingPercent: 75,
		});
	});

	it("treats an absent five-hour cap as fully available", () => {
		const usage = parseCodexUsage({
			rate_limit: {
				primary_window: null,
				secondary_window: {
					used_percent: 9,
					limit_window_seconds: 604_800,
				},
			},
		});

		expect(usage).toEqual({
			fiveHourRemainingPercent: 100,
			weeklyRemainingPercent: 91,
		});
	});

	it("rejects a response without a recognized Codex window", () => {
		const usage = parseCodexUsage({
			rate_limit: {
				primary_window: {
					used_percent: 25,
					limit_window_seconds: 3_600,
				},
			},
		});

		expect(usage).toBeNull();
	});
});

describe("formatCodexUsage", () => {
	it("renders compact five-hour and weekly labels", () => {
		const rendered = formatCodexUsage({
			fiveHourRemainingPercent: 83,
			weeklyRemainingPercent: 57,
		});

		expect(rendered).toBe("5h 83% | W 57%");
	});
});

describe("codexUsageStatusText", () => {
	it("renders Codex limits when visibility is enabled", () => {
		const rendered = codexUsageStatusText(
			"openai-codex",
			{
				fiveHourRemainingPercent: 88,
				weeklyRemainingPercent: 66,
			},
			true,
		);

		expect(rendered).toBe("5h 88% | W 66%");
	});

	it("hides limits when visibility is disabled", () => {
		const rendered = codexUsageStatusText(
			"openai-codex",
			{
				fiveHourRemainingPercent: 88,
				weeklyRemainingPercent: 66,
			},
			false,
		);

		expect(rendered).toBeUndefined();
	});

	it("hides limits for another provider", () => {
		const rendered = codexUsageStatusText(
			"anthropic",
			{
				fiveHourRemainingPercent: 88,
				weeklyRemainingPercent: 66,
			},
			true,
		);

		expect(rendered).toBeUndefined();
	});
});

describe("fetchCodexUsage", () => {
	it("uses resolved Senpi OAuth credentials", async () => {
		let requestedUrl = "";
		let requestedHeaders: Headers | undefined;
		let requestedRedirect: "error" | undefined;

		const usage = await fetchCodexUsage({
			credentials: {
				accessToken: "test-access",
				accountId: "test-account",
			},
			request: async (input, init) => {
				requestedUrl = input;
				requestedHeaders = new Headers(init.headers);
				requestedRedirect = init.redirect;
				return Response.json({
					rate_limit: {
						primary_window: {
							used_percent: 12,
							limit_window_seconds: 18_000,
						},
						secondary_window: {
							used_percent: 34,
							limit_window_seconds: 604_800,
						},
					},
				});
			},
		});

		expect({
			usage,
			requestedUrl,
			authorization: requestedHeaders?.get("Authorization"),
			accountId: requestedHeaders?.get("ChatGPT-Account-Id"),
			redirect: requestedRedirect,
		}).toEqual({
			usage: {
				fiveHourRemainingPercent: 88,
				weeklyRemainingPercent: 66,
			},
			requestedUrl: "https://chatgpt.com/backend-api/wham/usage",
			authorization: "Bearer test-access",
			accountId: "test-account",
			redirect: "error",
		});
	});

	it("forwards cancellation into the HTTP request", async () => {
		const controller = new AbortController();
		const requestStarted = Promise.withResolvers<void>();
		let requestSignal: AbortSignal | undefined;
		const request = fetchCodexUsage({
			credentials: {
				accessToken: "test-access",
				accountId: "test-account",
			},
			signal: controller.signal,
			request: async (_input, init) => {
				requestSignal = init.signal;
				requestStarted.resolve();
				await new Promise<never>((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
				});
				return Response.json({});
			},
		});

		await requestStarted.promise;
		controller.abort();

		await expect(request).rejects.toBeDefined();
		expect(requestSignal?.aborted).toBe(true);
	});
});

describe("startCodexUsagePolling", () => {
	it("publishes initial usage without waiting for an interval", async () => {
		const expected = {
			fiveHourRemainingPercent: 88,
			weeklyRemainingPercent: 66,
		};
		const observed = Promise.withResolvers<typeof expected | null>();
		const timeout = AbortSignal.timeout(1_000);
		const timedOut = new Promise<never>((_resolve, reject) => {
			timeout.addEventListener("abort", () => reject(new Error("usage polling did not publish")), { once: true });
		});

		const polling = startCodexUsagePolling({
			active: () => true,
			load: async () => expected,
			onUsage: observed.resolve,
			onError: observed.reject,
		});

		try {
			expect(await Promise.race([observed.promise, timedOut])).toEqual(expected);
		} finally {
			polling.stop();
		}
	});

	it("aborts an in-flight load without reporting an error after stop", async () => {
		const started = Promise.withResolvers<AbortSignal>();
		const finished = Promise.withResolvers<void>();
		const errors: unknown[] = [];
		const usages: unknown[] = [];
		const polling = startCodexUsagePolling({
			active: () => true,
			load: async (signal) => {
				started.resolve(signal);
				try {
					await new Promise<never>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					});
				} finally {
					finished.resolve();
				}
				return null;
			},
			onUsage: (usage) => usages.push(usage),
			onError: (error) => errors.push(error),
		});

		const signal = await started.promise;
		polling.stop();
		await finished.promise;

		expect(signal.aborted).toBe(true);
		expect(errors).toEqual([]);
		expect(usages).toEqual([]);
	});

	it("does not overlap manual and scheduled refreshes", async () => {
		const expected = {
			fiveHourRemainingPercent: 88,
			weeklyRemainingPercent: 66,
		};
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const observed = Promise.withResolvers<typeof expected | null>();
		let loadCalls = 0;
		const polling = startCodexUsagePolling({
			active: () => true,
			load: async () => {
				loadCalls += 1;
				started.resolve();
				await release.promise;
				return expected;
			},
			onUsage: observed.resolve,
			onError: observed.reject,
		});

		await started.promise;
		await polling.refresh();
		expect(loadCalls).toBe(1);
		release.resolve();
		expect(await observed.promise).toEqual(expected);
		polling.stop();
	});
});
