import { describe, expect, it } from "vitest";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../src/core/provider-display-names.ts";

describe("built-in provider display names", () => {
	it("labels the Ollama provider as the cloud service", () => {
		expect(BUILT_IN_PROVIDER_DISPLAY_NAMES.ollama).toBe("Ollama Cloud");
	});
});
