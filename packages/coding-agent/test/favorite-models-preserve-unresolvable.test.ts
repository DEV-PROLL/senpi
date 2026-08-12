import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { resolveModelScopeWithDiagnostics } from "../src/core/model-resolver.ts";
import { mergeFavoritePatternsForPersist } from "../src/modes/interactive/components/model-favorites.ts";

const availableModel: Model<"anthropic-messages"> = {
	id: "claude-fable-5",
	name: "Fable 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const availabilitySnapshot = { getAvailable: async () => [availableModel] };
const candidateIds = ["anthropic/claude-fable-5"];

async function unresolvedPatternsFor(storedPatterns: string[]): Promise<string[]> {
	const { diagnostics } = await resolveModelScopeWithDiagnostics(storedPatterns, availabilitySnapshot);
	return diagnostics.filter((diagnostic) => diagnostic.code === "no-match").map((diagnostic) => diagnostic.pattern);
}

describe("mergeFavoritePatternsForPersist", () => {
	describe("stored favorites whose providers are momentarily unavailable", () => {
		test("preserves unresolvable patterns when the selector persists its resolvable view", async () => {
			const storedPatterns = [
				"atlascloud/moonshotai/kimi-k3",
				"anthropic/claude-fable-5",
				"apitopia/deepseek-v4-flash",
			];
			const unresolvedPatterns = await unresolvedPatternsFor(storedPatterns);

			expect(unresolvedPatterns).toContain("atlascloud/moonshotai/kimi-k3");
			expect(unresolvedPatterns).toContain("apitopia/deepseek-v4-flash");

			const next = mergeFavoritePatternsForPersist({
				storedPatterns,
				unresolvedPatterns,
				selectedIds: ["anthropic/claude-fable-5"],
				candidateIds,
			});

			expect(next).toContain("atlascloud/moonshotai/kimi-k3");
			expect(next).toContain("apitopia/deepseek-v4-flash");
			expect(next).toContain("anthropic/claude-fable-5");
		});

		test("does not wipe settings when the visible selection is emptied", async () => {
			const storedPatterns = ["atlascloud/moonshotai/kimi-k3", "apitopia/deepseek-v4-flash"];
			const unresolvedPatterns = await unresolvedPatternsFor(storedPatterns);

			const next = mergeFavoritePatternsForPersist({
				storedPatterns,
				unresolvedPatterns,
				selectedIds: [],
				candidateIds,
			});

			expect(next).toEqual(storedPatterns);
		});

		test("preserves unresolvable patterns when every candidate is favorited", () => {
			const next = mergeFavoritePatternsForPersist({
				storedPatterns: ["atlascloud/moonshotai/kimi-k3", "anthropic/claude-fable-5"],
				unresolvedPatterns: ["atlascloud/moonshotai/kimi-k3"],
				selectedIds: null,
				candidateIds,
			});

			expect(next).toEqual(["atlascloud/moonshotai/kimi-k3", "anthropic/claude-fable-5"]);
		});

		test("keeps a selected pattern that is already stored from being duplicated", () => {
			const next = mergeFavoritePatternsForPersist({
				storedPatterns: ["atlascloud/moonshotai/kimi-k3", "anthropic/claude-fable-5"],
				unresolvedPatterns: ["atlascloud/moonshotai/kimi-k3"],
				selectedIds: ["anthropic/claude-fable-5"],
				candidateIds,
			});

			expect(next).toEqual(["atlascloud/moonshotai/kimi-k3", "anthropic/claude-fable-5"]);
		});
	});

	describe("a genuine user clear", () => {
		test("returns undefined when nothing is stored beyond the cleared selection", () => {
			const next = mergeFavoritePatternsForPersist({
				storedPatterns: ["anthropic/claude-fable-5"],
				unresolvedPatterns: [],
				selectedIds: [],
				candidateIds,
			});

			expect(next).toBeUndefined();
		});
	});
});
