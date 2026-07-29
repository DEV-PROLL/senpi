import { describe, expect, it } from "vitest";
import { hasCredentialHeaders, isCredentialHeaderName } from "../src/auth/headers.ts";

describe("credential headers", () => {
	it.each([
		"Authorization",
		"Proxy-Authorization",
		"x-api-key",
		"x-goog-api-key",
		"anthropic-api-key",
		"cf-aig-authorization",
		"x-auth-token",
		"x-access-token",
		"cf-access-client-secret",
	])("recognizes %s as credential-bearing", (name) => {
		expect(isCredentialHeaderName(name)).toBe(true);
		expect(hasCredentialHeaders({ [name]: "credential" })).toBe(true);
	});

	it.each(["User-Agent", "x-request-id", "x-trace-token", "content-type"])(
		"does not treat %s as credential-bearing",
		(name) => {
			expect(isCredentialHeaderName(name)).toBe(false);
			expect(hasCredentialHeaders({ [name]: "metadata" })).toBe(false);
		},
	);

	it("uses the last case-insensitive value and rejects empty authorization schemes", () => {
		expect(hasCredentialHeaders({ Authorization: "Bearer configured", authorization: "" })).toBe(false);
		expect(hasCredentialHeaders({ Authorization: "Bearer " })).toBe(false);
		expect(hasCredentialHeaders({ "x-api-key": "   " })).toBe(false);
	});
});
