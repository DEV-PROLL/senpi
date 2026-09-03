import { describe, expect, it } from "vitest";
import { streamClaudeSdkOauth } from "../../../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";
import { overrideSdkBoundary, resetSdkBoundary, type SDKMessage } from "../../../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";

function message(value: unknown): SDKMessage {
	return value as SDKMessage;
}

const model = {
	id: "claude-test",
	name: "Claude",
	api: "claude-sdk-oauth",
	provider: "claude-sdk-oauth",
	baseUrl: "",
	reasoning: true,
	input: ["text"] as ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

describe("regression #1169: Claude SDK is_error results", () => {
	it("fails a success-subtype session limit and preserves ordinary success", async () => {
		overrideSdkBoundary({
			query: () => ({
				async *[Symbol.asyncIterator]() {
					yield message({
						type: "result",
						subtype: "success",
						is_error: true,
						api_error_status: 429,
						terminal_reason: "blocking_limit",
						result: "You've hit your session limit · resets 2:50pm (Asia/Seoul)",
					});
				},
				async interrupt() {},
				close() {},
			}),
		});
		try {
			const failure = await streamClaudeSdkOauth(model, { messages: [] }).result();
			expect(failure.stopReason).toBe("error");
			expect(failure.errorMessage).toContain("session limit");
		} finally {
			resetSdkBoundary();
		}

		overrideSdkBoundary({
			query: () => ({
				async *[Symbol.asyncIterator]() {
					yield message({ type: "result", subtype: "success", is_error: false, result: "ordinary answer" });
				},
				async interrupt() {},
				close() {},
			}),
		});
		try {
			const success = await streamClaudeSdkOauth(model, { messages: [] }).result();
			expect(success.stopReason).not.toBe("error");
			expect(success.content).toEqual([{ type: "text", text: "ordinary answer" }]);
		} finally {
			resetSdkBoundary();
		}
	});
});
