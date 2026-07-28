import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { InlineExtension } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const cleanups: Array<() => void> = [];

async function createReloadSession(extensionFactories: InlineExtension[]) {
	const tempDir = join(tmpdir(), `pi-before-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });

	const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(agentDir, "models.json"),
	});

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
					...extensionFactories,
				],
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir,
		sessionManager: SessionManager.create(tempDir),
	});

	cleanups.push(() => {
		runtime.session.dispose();
		faux.unregister();
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	return { runtime };
}

describe("session_before_reload veto", () => {
	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
		vi.restoreAllMocks();
	});

	it("aborts reload before any teardown when an extension cancels", async () => {
		const shutdownReasons: string[] = [];
		const { runtime } = await createReloadSession([
			(pi) => {
				pi.on("session_before_reload", () => ({ cancel: true, reason: "2 subagents still running" }));
				pi.on("session_shutdown", (event) => {
					shutdownReasons.push(event.reason);
				});
			},
		]);
		const settingsReload = vi.spyOn(runtime.services.settingsManager, "reload");
		const runnerBefore = runtime.session.extensionRunner;

		const result = await runtime.session.reload();

		expect(result).toEqual({ cancelled: true, reason: "2 subagents still running" });
		expect(shutdownReasons).toEqual([]);
		expect(settingsReload).not.toHaveBeenCalled();
		expect(runtime.session.extensionRunner).toBe(runnerBefore);
	});

	it("reloads normally when no handler cancels", async () => {
		const shutdownReasons: string[] = [];
		const { runtime } = await createReloadSession([
			(pi) => {
				pi.on("session_before_reload", () => undefined);
				pi.on("session_shutdown", (event) => {
					shutdownReasons.push(event.reason);
				});
			},
		]);

		const result = await runtime.session.reload();

		expect(result).toEqual({ cancelled: false });
		expect(shutdownReasons).toEqual(["reload"]);
	});

	it("checkReloadVeto reports the veto without tearing anything down", async () => {
		const shutdownReasons: string[] = [];
		const { runtime } = await createReloadSession([
			(pi) => {
				pi.on("session_before_reload", () => ({ cancel: true, reason: "team members active" }));
				pi.on("session_shutdown", (event) => {
					shutdownReasons.push(event.reason);
				});
			},
		]);

		const veto = await runtime.session.checkReloadVeto();

		expect(veto).toEqual({ cancelled: true, reason: "team members active" });
		expect(shutdownReasons).toEqual([]);
	});
});
