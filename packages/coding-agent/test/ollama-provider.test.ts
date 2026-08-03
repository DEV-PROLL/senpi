import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

function mockCloudCatalog() {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = String(input);
		if (url === "https://ollama.com/api/tags") {
			if (new Headers(init?.headers).get("authorization") !== "Bearer test-key") {
				return new Response("unauthorized", { status: 401 });
			}
			return Response.json({ models: [{ name: "kimi-k3" }] });
		}
		if (url === "https://ollama.com/api/show") {
			return Response.json({
				model_info: {
					"general.architecture": "kimi-k3",
					"kimi-k3.context_length": 1048576,
				},
				capabilities: ["vision", "thinking", "completion", "tools"],
			});
		}
		return new Response("not found", { status: 404 });
	});
}

function writeLocalOllamaConfig(modelsPath: string): void {
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				ollama: {
					baseUrl: "http://localhost:11434/v1",
					api: "openai-completions",
					apiKey: "ollama",
					models: [{ id: "qwen2.5-coder:7b" }],
				},
			},
		}),
	);
}

describe("Ollama Cloud provider runtime", () => {
	it("keeps the provider-owned dynamic catalog refresh instead of replacing it with the pi.dev overlay", async () => {
		mockCloudCatalog();
		const modelsStore = new InMemoryModelsStore();
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				ollama: { type: "api_key", key: "test-key" },
			}),
			modelsStore,
			modelsPath: null,
			allowModelNetwork: true,
		});

		expect(runtime.getModel("ollama", "kimi-k3")).toMatchObject({
			provider: "ollama",
			baseUrl: "https://ollama.com/v1",
			contextWindow: 1048576,
		});
		expect((await modelsStore.read("ollama"))?.models.map((model) => model.id)).toEqual(["kimi-k3"]);
	});

	it("removes dynamic Cloud models when hot reload switches to an explicit local catalog", async () => {
		const fetchSpy = mockCloudCatalog();
		const directory = mkdtempSync(join(tmpdir(), "senpi-ollama-hot-reload-"));
		const modelsPath = join(directory, "models.json");

		try {
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory({
					ollama: { type: "api_key", key: "test-key" },
				}),
				modelsStore: new InMemoryModelsStore(),
				modelsPath,
				allowModelNetwork: true,
			});
			expect(runtime.getModel("ollama", "kimi-k3")).toBeDefined();
			const cloudRequestCount = fetchSpy.mock.calls.length;

			writeLocalOllamaConfig(modelsPath);
			await runtime.refresh({ allowNetwork: true });

			expect(runtime.getModel("ollama", "kimi-k3")).toBeUndefined();
			expect(runtime.getModels("ollama").map((model) => model.id)).toEqual(["qwen2.5-coder:7b"]);
			expect(runtime.getModel("ollama", "qwen2.5-coder:7b")).toMatchObject({
				baseUrl: "http://localhost:11434/v1",
			});
			expect(fetchSpy).toHaveBeenCalledTimes(cloudRequestCount);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps a documented local Ollama models.json catalog offline", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected Cloud request"));
		const directory = mkdtempSync(join(tmpdir(), "senpi-local-ollama-"));
		const modelsPath = join(directory, "models.json");
		writeLocalOllamaConfig(modelsPath);

		try {
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory({}),
				modelsStore: new InMemoryModelsStore(),
				modelsPath,
				allowModelNetwork: true,
			});

			expect(runtime.getModel("ollama", "qwen2.5-coder:7b")).toMatchObject({
				baseUrl: "http://localhost:11434/v1",
			});
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
