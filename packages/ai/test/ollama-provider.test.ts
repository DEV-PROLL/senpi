import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryModelsStore, type ModelsStoreEntry } from "../src/models-store.ts";
import { ollamaProvider } from "../src/providers/ollama.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

function scopedStore(store: InMemoryModelsStore) {
	return {
		read: () => store.read("ollama"),
		write: (entry: ModelsStoreEntry) => store.write("ollama", entry),
		delete: () => store.delete("ollama"),
	};
}

describe("Ollama Cloud provider discovery", () => {
	it("discovers tool-capable models and derives their capabilities from Ollama metadata", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			const authorization = new Headers(init?.headers).get("authorization");
			if (authorization !== "Bearer test-key") {
				return new Response("unauthorized", { status: 401 });
			}
			if (url === "https://ollama.example.test/api/tags") {
				return Response.json({
					models: [
						{
							name: "kimi-k3",
							model: "kimi-k3",
							modified_at: "2026-07-30T00:00:00Z",
							size: 0,
							digest: "sha256:kimi",
							details: {
								parent_model: "",
								format: "gguf",
								family: "kimi-k3",
								families: ["kimi-k3"],
								parameter_size: "1T",
								quantization_level: "native",
							},
						},
						{
							name: "embedding-only",
							model: "embedding-only",
							modified_at: "2026-07-30T00:00:00Z",
							size: 0,
							digest: "sha256:embed",
							details: {
								parent_model: "",
								format: "gguf",
								family: "embed",
								families: ["embed"],
								parameter_size: "1B",
								quantization_level: "native",
							},
						},
					],
				});
			}
			if (url === "https://ollama.example.test/api/show") {
				const body = JSON.parse(String(init?.body)) as { model: string };
				if (body.model === "kimi-k3") {
					return Response.json({
						license: "",
						modelfile: "",
						parameters: "",
						template: "",
						details: {
							parent_model: "",
							format: "gguf",
							family: "kimi-k3",
							families: ["kimi-k3"],
							parameter_size: "1T",
							quantization_level: "native",
						},
						model_info: {
							"general.architecture": "kimi-k3",
							"kimi-k3.context_length": 1048576,
						},
						capabilities: ["vision", "thinking", "completion", "tools"],
					});
				}
				return Response.json({
					license: "",
					modelfile: "",
					parameters: "",
					template: "",
					details: {
						parent_model: "",
						format: "gguf",
						family: "embed",
						families: ["embed"],
						parameter_size: "1B",
						quantization_level: "native",
					},
					model_info: {
						"general.architecture": "embed",
						"embed.context_length": 8192,
					},
					capabilities: ["embedding"],
				});
			}
			return new Response("not found", { status: 404 });
		});
		const provider = ollamaProvider({ baseUrl: "https://ollama.example.test" });
		const store = new InMemoryModelsStore();

		await provider.refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			store: scopedStore(store),
			allowNetwork: true,
		});

		expect(provider.getModels()).toEqual([
			expect.objectContaining({
				id: "kimi-k3",
				name: "kimi-k3",
				api: "openai-completions",
				provider: "ollama",
				baseUrl: "https://ollama.example.test/v1",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1048576,
				maxTokens: 16384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: true,
					maxTokensField: "max_tokens",
					supportsStrictMode: false,
					supportsLongCacheRetention: false,
				},
			}),
		]);
		expect((await store.read("ollama"))?.models.map((model) => model.id)).toEqual(["kimi-k3"]);
	});

	it("keeps usable models when one tagged model disappears before inspection", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			if (url === "https://ollama.example.test/api/tags") {
				return Response.json({ models: [{ name: "usable" }, { name: "stale" }] });
			}
			if (url === "https://ollama.example.test/api/show") {
				const body = JSON.parse(String(init?.body)) as { model: string };
				if (body.model === "stale") return new Response("gone", { status: 404 });
				return Response.json({
					model_info: { "general.architecture": "usable", "usable.context_length": 65536 },
					capabilities: ["completion", "tools"],
				});
			}
			return new Response("not found", { status: 404 });
		});
		const provider = ollamaProvider({ baseUrl: "https://ollama.example.test" });
		const store = new InMemoryModelsStore();

		await provider.refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			store: scopedStore(store),
			allowNetwork: true,
		});

		expect(provider.getModels().map((model) => model.id)).toEqual(["usable"]);
		expect((await store.read("ollama"))?.models.map((model) => model.id)).toEqual(["usable"]);
	});
});
