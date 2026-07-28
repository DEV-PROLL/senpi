import { describe, expect, it } from "vitest";
import { humanizeProviderError, sessionTitleRetryPolicy } from "../src/core/session-title-generator.ts";

describe("sessionTitleRetryPolicy", () => {
	it("caps the cosmetic title retry below the full agent-turn budget", () => {
		expect(sessionTitleRetryPolicy({ enabled: true, maxRetries: 3, baseDelayMs: 2000 })).toEqual({
			enabled: true,
			maxRetries: 1,
			baseDelayMs: 2000,
		});
	});

	it("keeps a smaller user budget instead of inflating it", () => {
		expect(sessionTitleRetryPolicy({ enabled: true, maxRetries: 0, baseDelayMs: 500 })).toEqual({
			enabled: true,
			maxRetries: 0,
			baseDelayMs: 500,
		});
	});

	it("caps a long user backoff so a title never stalls for minutes", () => {
		expect(sessionTitleRetryPolicy({ enabled: true, maxRetries: 5, baseDelayMs: 60_000 })).toEqual({
			enabled: true,
			maxRetries: 1,
			baseDelayMs: 2000,
		});
	});

	it("honors a disabled retry policy", () => {
		expect(sessionTitleRetryPolicy({ enabled: false, maxRetries: 3, baseDelayMs: 2000 })).toEqual({
			enabled: false,
			maxRetries: 1,
			baseDelayMs: 2000,
		});
	});
});

describe("humanizeProviderError", () => {
	it("extracts message, type, and request id from an Anthropic SSE error body", () => {
		expect(
			humanizeProviderError(
				'{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CdRmGPa88udPD5fc8dt8U"}',
			),
		).toBe("Overloaded (overloaded_error, request req_011CdRmGPa88udPD5fc8dt8U)");
	});

	it("parses the `<prefix> (<status>): <body>` shape formatProviderError emits", () => {
		expect(humanizeProviderError('OpenAI (503): {"error":{"message":"Service unavailable"}}')).toBe(
			"Service unavailable (HTTP 503)",
		);
	});

	it("falls back to the HTTP status when the body carries no error type", () => {
		expect(humanizeProviderError('529: {"message":"Overloaded"}')).toBe("Overloaded (HTTP 529)");
	});

	it("keeps a string-valued error body instead of falling back to raw JSON", () => {
		expect(humanizeProviderError('503: {"error":"blocked by gateway WAF"}')).toBe(
			"blocked by gateway WAF (HTTP 503)",
		);
	});

	it("retains the HTTP status alongside the provider error type", () => {
		expect(humanizeProviderError('529: {"message":"Overloaded","type":"server_error"}')).toBe(
			"Overloaded (server_error, HTTP 529)",
		);
	});

	it("returns non-JSON messages unchanged", () => {
		expect(humanizeProviderError("title provider failed")).toBe("title provider failed");
	});

	it("returns unrecognized JSON unchanged", () => {
		expect(humanizeProviderError('{"details":"no message here"}')).toBe('{"details":"no message here"}');
	});
});
