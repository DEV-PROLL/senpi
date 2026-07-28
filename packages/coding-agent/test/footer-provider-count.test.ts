import { describe, expect, it } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("updateAvailableProviderCount", () => {
	it("populates the provider count from the current snapshot without refreshing", () => {
		const snapshot = [
			{ provider: "anthropic", id: "claude-a" },
			{ provider: "anthropic", id: "claude-b" },
			{ provider: "openai", id: "gpt-a" },
		];

		let count: number | undefined;
		let refreshCalled = false;
		const interactiveModeStub = {
			session: {
				scopedModels: [],
				modelRuntime: {
					getAvailableSnapshot: () => snapshot,
					refresh: () => {
						refreshCalled = true;
						return Promise.resolve();
					},
				},
			},
			footerDataProvider: {
				setAvailableProviderCount: (n: number) => {
					count = n;
				},
			},
		};

		(
			InteractiveMode.prototype as unknown as { updateAvailableProviderCount(): void }
		).updateAvailableProviderCount.call(interactiveModeStub);

		expect(refreshCalled).toBe(false);
		expect(count).toBe(2);
	});

	it("counts scoped models when the session has a model scope", () => {
		const snapshot = [{ provider: "openai", id: "gpt-a" }];
		const scopedModels = [
			{ model: { provider: "anthropic", id: "claude-a" } },
			{ model: { provider: "anthropic", id: "claude-b" } },
			{ model: { provider: "openai", id: "gpt-b" } },
		];

		let count: number | undefined;
		let refreshCalled = false;
		const interactiveModeStub = {
			session: {
				scopedModels,
				modelRuntime: {
					getAvailableSnapshot: () => snapshot,
					refresh: () => {
						refreshCalled = true;
						return Promise.resolve();
					},
				},
			},
			footerDataProvider: {
				setAvailableProviderCount: (n: number) => {
					count = n;
				},
			},
		};

		(
			InteractiveMode.prototype as unknown as { updateAvailableProviderCount(): void }
		).updateAvailableProviderCount.call(interactiveModeStub);

		expect(refreshCalled).toBe(false);
		expect(count).toBe(2);
	});
});
