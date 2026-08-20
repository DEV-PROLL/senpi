import { describe, expect, it } from "vitest";
import { isContextOverflow, isCursorPayloadResourceExhausted } from "../src/utils/overflow.ts";

const zeroRe = {
	stopReason: "error" as const,
	errorMessage: "Connect error resource_exhausted: Error",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
};

describe("isCursorPayloadResourceExhausted", () => {
	it("treats large 0-token Cursor RE as payload overflow", () => {
		expect(isContextOverflow(zeroRe, 1_000_000)).toBe(false);
		expect(isCursorPayloadResourceExhausted(zeroRe, 150_000)).toBe(true);
		expect(isCursorPayloadResourceExhausted(zeroRe, 1_000)).toBe(false);
	});
});
