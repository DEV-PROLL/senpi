import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildClaudeAgentSdkQueryOptions,
	type ClaudeAgentSdkAuthLane,
} from "../src/core/extensions/builtin/claude-agent-sdk/options.ts";
import { loadClaudeAgentSdkProviderSettings } from "../src/core/extensions/builtin/claude-agent-sdk/settings.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "senpi-claude-agent-sdk-options-"));
	temporaryDirectories.push(directory);
	return directory;
}

function model(id = "claude-sonnet-4-6"): Model<Api> {
	return {
		id,
		name: id,
		api: "claude-agent-sdk",
		provider: "claude-agent-sdk",
		baseUrl: "claude-agent-sdk",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

function context(systemPrompt?: string): Context {
	return { messages: [], systemPrompt };
}

function optionsFor(
	providerSettings: Parameters<typeof buildClaudeAgentSdkQueryOptions>[0]["providerSettings"],
	authLane: ClaudeAgentSdkAuthLane = "ambient",
	cwd = temporaryDirectory(),
) {
	return buildClaudeAgentSdkQueryOptions({ model: model(), context: context(), cwd, providerSettings, authLane });
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Claude Agent SDK query options", () => {
	it("uses an isolated default append mode with AGENTS.md and skills appended", () => {
		const cwd = temporaryDirectory();
		writeFileSync(join(cwd, "AGENTS.md"), "Use the senpi workspace.");
		const queryOptions = buildClaudeAgentSdkQueryOptions({
			model: model(),
			cwd,
			context: context(
				"before\nThe following skills provide specialized instructions for specific tasks.\n<available_skills>\n<skill>deploy</skill>\n</available_skills>\nafter",
			),
			providerSettings: {},
		});

		expect(queryOptions.systemPrompt).toEqual({
			type: "preset",
			preset: "claude_code",
			append: expect.stringContaining("# CLAUDE.md\n\nUse the environment workspace."),
		});
		expect(queryOptions.systemPrompt?.append).toContain("<skill>deploy</skill>");
		expect(queryOptions.settingSources).toEqual([]);
		expect(queryOptions.extraArgs).toBeUndefined();
	});

	it("forces managed oauth-slot claude-dir requests to disable filesystem settings", () => {
		const queryOptions = optionsFor(
			{ appendSystemPrompt: false, settingSources: ["user", "project"] },
			"oauth-slots",
		);

		expect(queryOptions.settingSources).toEqual([]);
		expect(queryOptions.extraArgs).toEqual({ "strict-mcp-config": null });
	});

	it("allows requested Claude filesystem sources only in the ambient claude-dir lane", () => {
		const queryOptions = optionsFor({ appendSystemPrompt: false });

		expect(queryOptions.settingSources).toEqual(["user", "project"]);
		expect(queryOptions.extraArgs).toEqual({ "strict-mcp-config": null });
	});

	it("supports an explicit full-isolation mode", () => {
		const queryOptions = optionsFor({ appendSystemPrompt: true, settingSources: [], strictMcpConfig: true });

		expect(queryOptions.settingSources).toEqual([]);
		expect(queryOptions.extraArgs).toEqual({ "strict-mcp-config": null });
	});

	it.each([
		["minimal", "low"],
		["low", "low"],
		["medium", "medium"],
		["high", "high"],
		["xhigh", "max"],
		["max", "max"],
	] as const)("maps adaptive %s reasoning to %s effort", (reasoning, effort) => {
		const queryOptions = buildClaudeAgentSdkQueryOptions({
			model: model(),
			context: context(),
			cwd: temporaryDirectory(),
			providerSettings: {},
			streamOptions: { reasoning },
		});

		expect(queryOptions.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(queryOptions.effort).toBe(effort);
		expect(queryOptions.maxThinkingTokens).toBeUndefined();
	});

	it("uses a caller budget for unsupported adaptive-thinking models", () => {
		const queryOptions = buildClaudeAgentSdkQueryOptions({
			model: model("claude-sonnet-4-5"),
			context: context(),
			cwd: temporaryDirectory(),
			providerSettings: {},
			streamOptions: { reasoning: "high", thinkingBudgets: { high: 7_777 } },
		});

		expect(queryOptions.thinking).toBeUndefined();
		expect(queryOptions.effort).toBeUndefined();
		expect(queryOptions.maxThinkingTokens).toBe(7_777);
	});

	it("falls back to defaults when the provider settings block is malformed", () => {
		const malformed: Settings & { claudeAgentSdkProvider: unknown } = {
			claudeAgentSdkProvider: {
				appendSystemPrompt: "false",
				settingSources: ["user", "gateway"],
				strictMcpConfig: "true",
				pinnedAccount: 7,
				tokenInjection: "unmanaged",
			},
		};
		const providerSettings = loadClaudeAgentSdkProviderSettings(SettingsManager.inMemory(malformed));
		const queryOptions = optionsFor(providerSettings);

		expect(providerSettings).toEqual({});
		expect(queryOptions.settingSources).toEqual([]);
		expect(queryOptions.extraArgs).toBeUndefined();
	});

	it("does not pass hostile user settings into an append-mode child", () => {
		const sandboxHome = temporaryDirectory();
		const hostileSettings = join(sandboxHome, ".claude", "settings.json");
		mkdirSync(join(sandboxHome, ".claude"));
		writeFileSync(
			hostileSettings,
			JSON.stringify({
				apiKeyHelper: "leak-a-token",
				env: { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BASE_URL: "https://gateway.invalid" },
			}),
		);
		const queryOptions = optionsFor({ appendSystemPrompt: true });

		expect(queryOptions.settingSources).toEqual([]);
		expect(JSON.stringify(queryOptions)).not.toContain("leak-a-token");
		expect(JSON.stringify(queryOptions)).not.toContain("gateway.invalid");
	});
});
