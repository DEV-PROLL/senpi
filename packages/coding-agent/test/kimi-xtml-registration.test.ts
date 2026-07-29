import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { getProtocol, getToolCallFormat } from "../../ai/src/tool-call-middleware/index.ts";
import type { Model, Tool } from "../../ai/src/types.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

const weatherTool: Tool = {
	name: "get_weather",
	description: "Get weather for a city",
	parameters: Type.Object({ city: Type.String() }),
};

const kimiXtmlModel = {
	id: "kimi-k3",
	name: "Kimi K3",
	api: "openai-completions",
	provider: "registration-test",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
	compat: { toolCallFormat: "kimi-xtml" },
} satisfies Model<"openai-completions">;

describe("kimi-xtml registration", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir !== undefined) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("activates kimi-xtml for an openai-completions model with compat", () => {
		// When
		const format = getToolCallFormat(kimiXtmlModel);

		// Then
		expect(format).toBe("kimi-xtml");
	});

	it("parses an XTML block through the registered protocol", () => {
		// Given
		const generatedText =
			"<|open|>tools<|sep|>" +
			'<|open|>call tool="get_weather" index="1"<|sep|>' +
			'<|open|>argument key="city" type="string"<|sep|>Seoul<|close|>argument<|sep|>' +
			"<|close|>call<|sep|>" +
			"<|close|>tools<|sep|>";

		// When
		const parsed = getProtocol("kimi-xtml").parseGeneratedText(generatedText, [weatherTool]);

		// Then
		expect(parsed).toEqual([{ name: "get_weather", arguments: { city: "Seoul" } }]);
	});

	it("accepts kimi-xtml in a models.json compatibility block", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-kimi-xtml-registration-"));
		const modelsJsonPath = join(tempDir, "models.json");
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"registration-test": {
						api: "openai-completions",
						baseUrl: "https://example.invalid/v1",
						compat: { toolCallFormat: "kimi-xtml" },
						models: [{ id: "kimi-xtml-model" }],
					},
				},
			}),
		);

		// When
		const registry = ModelRegistry.create(AuthStorage.create(join(tempDir, "auth.json")), modelsJsonPath);

		// Then
		expect(registry.getError()).toBeUndefined();
		expect(registry.find("registration-test", "kimi-xtml-model")?.id).toBe("kimi-xtml-model");
	});
});
