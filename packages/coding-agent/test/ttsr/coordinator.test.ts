import { type AssistantMessage, isRetryableAssistantError, type Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
	claimAbort,
	createGenerationState,
	markUserCancelled,
	resolveDetection,
} from "../../src/core/extensions/builtin/ttsr/coordinator.ts";
import {
	COLLAPSE_RULE_CONTENT,
	COLLAPSE_RULE_NAME,
	CONTROL_LEAK_RULE_NAME,
	LEAK_ERROR_MESSAGE,
	renderSystemInterrupt,
} from "../../src/core/extensions/builtin/ttsr/prompts.ts";
import {
	buildErrorShellReplacement,
	buildNudgeMessage,
	buildTruncateReplacement,
} from "../../src/core/extensions/builtin/ttsr/remediation.ts";
import {
	COLLAPSE_REMEDIATION,
	CONTROL_LEAK_REMEDIATION,
	type DetectionResolution,
	type DetectorMatch,
	TTSR_INJECTION_CUSTOM_TYPE,
} from "../../src/core/extensions/builtin/ttsr/types.ts";

function makeMatch(rule: DetectorMatch["rule"], overrides: Partial<DetectorMatch> = {}): DetectorMatch {
	return { rule, reason: `${rule} fired`, anomalyStartOffset: 12, garbageStartOffset: 12, detail: {}, ...overrides };
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeAssistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "fixture-model",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function mustResolve(
	directLeak: DetectorMatch | null,
	collapse: DetectorMatch | null,
	corroboratedLeak: DetectorMatch | null,
): DetectionResolution {
	const resolution = resolveDetection(directLeak, collapse, corroboratedLeak);
	if (!resolution) throw new Error("expected a resolution");
	return resolution;
}

describe("resolveDetection precedence", () => {
	it("returns null when nothing matched", () => {
		expect(resolveDetection(null, null, null)).toBeNull();
	});

	it("direct leak alone owns the generation", () => {
		const leak = makeMatch("control-token-leak");
		const resolution = mustResolve(leak, null, null);
		expect(resolution.owner).toBe(CONTROL_LEAK_RULE_NAME);
		expect(resolution.observedRules).toEqual([CONTROL_LEAK_RULE_NAME]);
		expect(resolution.match).toBe(leak);
		expect(resolution.remediation).toBe(CONTROL_LEAK_REMEDIATION);
		expect(resolution.remediation.corruptionScope).toBe("generation");
	});

	it("collapse alone owns the output region", () => {
		const collapse = makeMatch("collapse-repetition");
		const resolution = mustResolve(null, collapse, null);
		expect(resolution.owner).toBe(COLLAPSE_RULE_NAME);
		expect(resolution.observedRules).toEqual([COLLAPSE_RULE_NAME]);
		expect(resolution.match).toBe(collapse);
		expect(resolution.remediation).toBe(COLLAPSE_REMEDIATION);
		expect(resolution.remediation.corruptionScope).toBe("output-region");
	});

	it("leak wins when both fire, collapse stays observed", () => {
		const leak = makeMatch("control-token-leak");
		const collapse = makeMatch("collapse-repetition");
		const resolution = mustResolve(leak, collapse, null);
		expect(resolution.owner).toBe(CONTROL_LEAK_RULE_NAME);
		expect(resolution.observedRules).toEqual([CONTROL_LEAK_RULE_NAME, COLLAPSE_RULE_NAME]);
		expect(resolution.match).toBe(leak);
		expect(resolution.remediation.retryMode).toBe("provider-error");
	});

	it("corroborated leak owns without a direct leak", () => {
		const corroborated = makeMatch("control-token-leak", { reason: "corroborated by collapse" });
		const collapse = makeMatch("collapse-repetition");
		const resolution = mustResolve(null, collapse, corroborated);
		expect(resolution.owner).toBe(CONTROL_LEAK_RULE_NAME);
		expect(resolution.observedRules).toEqual([CONTROL_LEAK_RULE_NAME, COLLAPSE_RULE_NAME]);
		expect(resolution.match).toBe(corroborated);
	});

	it("corroborated leak without collapse observes only the leak", () => {
		const corroborated = makeMatch("control-token-leak");
		expect(mustResolve(null, null, corroborated).observedRules).toEqual([CONTROL_LEAK_RULE_NAME]);
	});

	it("direct leak is the reported match when corroboration also exists", () => {
		const direct = makeMatch("control-token-leak", { anomalyStartOffset: 3 });
		const corroborated = makeMatch("control-token-leak", { anomalyStartOffset: 40 });
		expect(mustResolve(direct, null, corroborated).match).toBe(direct);
	});
});

describe("claimAbort latch", () => {
	it("first claim wins and stamps owner and timestamp", () => {
		const state = createGenerationState();
		expect(state).toEqual({ abortClaimed: false, userCancelled: false });
		const before = Date.now();
		expect(claimAbort(state, mustResolve(null, makeMatch("collapse-repetition"), null))).toBe(true);
		expect(state.abortClaimed).toBe(true);
		expect(state.abortOwner).toBe(COLLAPSE_RULE_NAME);
		expect(state.selfAbortAt).toBeGreaterThanOrEqual(before);
	});

	it("second claim is rejected and keeps the original owner", () => {
		const state = createGenerationState();
		expect(claimAbort(state, mustResolve(null, makeMatch("collapse-repetition"), null))).toBe(true);
		expect(claimAbort(state, mustResolve(makeMatch("control-token-leak"), null, null))).toBe(false);
		expect(state.abortOwner).toBe(COLLAPSE_RULE_NAME);
	});

	it("late detection after a claim can never claim again", () => {
		const state = createGenerationState();
		expect(claimAbort(state, mustResolve(makeMatch("control-token-leak"), null, null))).toBe(true);
		for (let i = 0; i < 3; i += 1) {
			expect(claimAbort(state, mustResolve(null, makeMatch("collapse-repetition"), null))).toBe(false);
		}
		expect(state.abortOwner).toBe(CONTROL_LEAK_RULE_NAME);
	});

	it("user cancellation stands down all future claims", () => {
		const state = createGenerationState();
		markUserCancelled(state);
		expect(state.userCancelled).toBe(true);
		expect(claimAbort(state, mustResolve(makeMatch("control-token-leak"), null, null))).toBe(false);
		expect(state.abortClaimed).toBe(false);
		expect(state.abortOwner).toBeUndefined();
	});

	it("cancellation after a claim keeps the claim latched", () => {
		const state = createGenerationState();
		expect(claimAbort(state, mustResolve(makeMatch("control-token-leak"), null, null))).toBe(true);
		markUserCancelled(state);
		expect(claimAbort(state, mustResolve(makeMatch("control-token-leak"), null, null))).toBe(false);
		expect(state.abortOwner).toBe(CONTROL_LEAK_RULE_NAME);
	});
});

describe("buildErrorShellReplacement", () => {
	it("builds the discard shell with the leak error message", () => {
		expect(buildErrorShellReplacement()).toEqual({
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: LEAK_ERROR_MESSAGE,
		});
	});

	it("never spells a control token in the error message", () => {
		const shell = buildErrorShellReplacement();
		expect(shell.errorMessage.includes(String.fromCharCode(60, 124))).toBe(false);
		expect(shell.errorMessage.includes(String.fromCharCode(124, 62))).toBe(false);
	});

	it("is classified retryable by the real pi-ai classifier", () => {
		const shell = buildErrorShellReplacement();
		const message = makeAssistantMessage({
			content: shell.content,
			stopReason: shell.stopReason,
			errorMessage: shell.errorMessage,
		});
		expect(isRetryableAssistantError(message)).toBe(true);
	});
});

describe("buildTruncateReplacement", () => {
	const thinking = `steady reasoning ${"ok ".repeat(64)}`;
	const marker = "[output interrupted by stream rule]";

	it("truncates the matched thinking block and keeps stopReason aborted", () => {
		const message = makeAssistantMessage({ content: [{ type: "thinking", thinking }], stopReason: "aborted" });
		const truncated = buildTruncateReplacement({ ...message }, 24, "thinking");
		expect(truncated.content).toEqual([
			{ type: "thinking", thinking: thinking.slice(0, 24) },
			{ type: "text", text: marker },
		]);
		expect(truncated.stopReason).toBe("aborted");
		expect(truncated.timestamp).toBe(message.timestamp);
	});

	it("truncates the matched text block", () => {
		const message = makeAssistantMessage({ content: [{ type: "text", text: "abcdef" }], stopReason: "aborted" });
		expect(buildTruncateReplacement({ ...message }, 3, "text").content).toEqual([
			{ type: "text", text: "abc" },
			{ type: "text", text: marker },
		]);
	});

	it("walks same-kind blocks on concatenated offsets and drops later garbage", () => {
		const content: AssistantMessage["content"] = [
			{ type: "thinking", thinking: "good" },
			{ type: "text", text: "kept" },
			{ type: "thinking", thinking: "garbage" },
			{ type: "thinking", thinking: "late garbage" },
		];
		const message = makeAssistantMessage({ content, stopReason: "aborted" });
		expect(buildTruncateReplacement({ ...message }, 6, "thinking").content).toEqual([
			{ type: "thinking", thinking: "good" },
			{ type: "text", text: "kept" },
			{ type: "thinking", thinking: "ga" },
			{ type: "text", text: marker },
		]);
	});

	it("strips a transport-timeout error message but keeps other fields", () => {
		const message = makeAssistantMessage({
			content: [{ type: "text", text: "abcdef" }],
			stopReason: "aborted",
			errorMessage: "Request timed out.",
		});
		const truncated = buildTruncateReplacement({ ...message }, 2, "text");
		expect(truncated.errorMessage).toBeUndefined();
		expect(truncated.model).toBe("fixture-model");
	});

	it("keeps a non-timeout error message untouched", () => {
		const message = makeAssistantMessage({
			content: [{ type: "text", text: "abcdef" }],
			stopReason: "error",
			errorMessage: "provider exploded",
		});
		expect(buildTruncateReplacement({ ...message }, 2, "text").errorMessage).toBe("provider exploded");
	});

	it("aborted truncation is not retryable by the real pi-ai classifier", () => {
		const message = makeAssistantMessage({ content: [{ type: "thinking", thinking }], stopReason: "aborted" });
		const truncated = buildTruncateReplacement({ ...message }, 24, "thinking");
		const rehydrated = makeAssistantMessage({
			content: [
				{ type: "thinking", thinking: thinking.slice(0, 24) },
				{ type: "text", text: marker },
			],
			stopReason: "aborted",
		});
		expect(truncated.stopReason).toBe("aborted");
		expect(isRetryableAssistantError(rehydrated)).toBe(false);
	});
});

describe("buildNudgeMessage", () => {
	it("renders the interrupt as a hidden ttsr-injection custom message", () => {
		const nudge = buildNudgeMessage(COLLAPSE_RULE_NAME, COLLAPSE_RULE_CONTENT);
		expect(nudge.customType).toBe(TTSR_INJECTION_CUSTOM_TYPE);
		expect(nudge.display).toBe(false);
		expect(nudge.details).toEqual({ rules: [COLLAPSE_RULE_NAME] });
		expect(nudge.content).toBe(renderSystemInterrupt(COLLAPSE_RULE_NAME, COLLAPSE_RULE_CONTENT));
		expect(nudge.content).toContain(COLLAPSE_RULE_NAME);
	});
});
