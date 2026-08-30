import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { resolveCompactionSettings } from "../../src/core/compaction-settings-resolver.ts";
import {
	admitContextToolResult,
	admitContextToolResults,
	resolveBeforeAgentStartMessage,
	resolveCompactionGeometry,
	resolveReminderSystemPrompt,
	shouldDeferGraceBand,
} from "../../src/core/extensions/builtin/compaction/orchestration.ts";
import { TOOL_ADMISSION_MARKER_PREFIX } from "../../src/core/extensions/builtin/compaction/tool-admission.ts";

describe("ideal compaction extension wiring decisions", () => {
	it("defers an in-flight compaction inside the grace band", () => {
		expect(
			shouldDeferGraceBand({
				tokens: 82_000,
				thresholdTokens: 80_000,
				leadTokens: 10_000,
				contextWindow: 100_000,
				reserveTokens: 10_000,
				compactionInFlight: true,
				graceBandEnabled: true,
			}),
		).toBe(true);
	});

	it("blocks past the grace cap or when the setting is disabled", () => {
		const base = {
			tokens: 91_000,
			thresholdTokens: 80_000,
			leadTokens: 10_000,
			contextWindow: 100_000,
			reserveTokens: 10_000,
			compactionInFlight: true,
			graceBandEnabled: true,
		};
		expect(shouldDeferGraceBand(base)).toBe(false);
		expect(shouldDeferGraceBand({ ...base, tokens: 82_000, graceBandEnabled: false })).toBe(false);
	});

	it("delivers a reminder through the system-prompt seam on an ordinary turn", () => {
		expect(resolveBeforeAgentStartMessage({ message: undefined, reminder: "budget reminder" })).toBeUndefined();
		expect(resolveReminderSystemPrompt({ systemPrompt: "base", reminder: "budget reminder" })).toBe(
			"base\n\nbudget reminder",
		);
	});

	it("merges a simultaneous reminder into the pending restoration message", () => {
		const restoration = { customType: "compaction-restoration", content: "restore checkpoint", display: false };
		expect(resolveBeforeAgentStartMessage({ message: restoration, reminder: "budget reminder" })).toEqual({
			...restoration,
			content: "restore checkpoint\n\nbudget reminder",
		});
		expect(
			resolveBeforeAgentStartMessage({
				message: restoration,
				reminder: "budget reminder",
				reminderEnabled: false,
			}),
		).toEqual(restoration);
	});

	it("clamps one configured lead for trigger, grace, and reminder geometry", () => {
		const base = { contextWindow: 200_000, lastYield: undefined };
		const low = resolveCompactionGeometry({
			...base,
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, speculativeLeadTokens: 1 },
		});
		const high = resolveCompactionGeometry({
			...base,
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, speculativeLeadTokens: 1_000_000 },
		});
		const automatic = resolveCompactionGeometry({
			...base,
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		});
		expect(automatic).toMatchObject({ thresholdTokens: 140_000, leadTokens: 17_500 });
		expect(low).toMatchObject({ thresholdTokens: 140_000, leadTokens: 8192 });
		expect(high).toMatchObject({ thresholdTokens: 140_000, leadTokens: 32_768 });
	});

	it("falls back to safe defaults for malformed JSON settings fields", () => {
		const settings = resolveCompactionSettings({ keepRecentTokens: "bad" as never, speculativeFraction: Number.NaN });
		expect(settings.keepRecentTokens).toBe(20_000);
		expect(settings.speculativeFraction).toBe(0.75);
	});

	it("caps multipart tool text blocks with one aggregate budget and preserves images", () => {
		const cap = 10_000;
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "tool-1",
				toolName: "test",
				content: [
					{ type: "text" as const, text: "a".repeat(cap * 8) },
					image,
					{ type: "text" as const, text: "b".repeat(cap * 8) },
				],
				isError: false,
				timestamp: 0,
			},
		];
		const projected = admitContextToolResults(messages, 200_000, true)[0];
		const projectedContent = (projected as { content: Array<{ type: string; text?: string }> }).content;
		const text = projectedContent
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("");
		expect(estimateTokens({ role: "user", content: text, timestamp: 0 })).toBeLessThanOrEqual(cap);
		expect(projectedContent).toContainEqual(image);
	});

	it("bypasses admission when an exact marker line sits inside the output", () => {
		const marker = `${TOOL_ADMISSION_MARKER_PREFIX} kept 10 of ~99 tokens; full output at /tmp/x.txt - read it with the read tool if needed]`;
		const marked = `head\n${marker}\ntail`;
		expect(admitContextToolResult(marked, 100_000, "/tmp/spill")).toEqual({ text: marked, admitted: false });
	});
});
