import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildBashTimeoutPrompt,
	resolveBashTimeoutDefaults,
} from "../src/core/extensions/builtin/bash-timeout/timeout.ts";
import { TERMINAL_PROMPT_SECTION } from "../src/core/extensions/builtin/terminal/prompt.ts";
import { createPtyBashTool } from "../src/core/extensions/builtin/terminal/tools/bash.ts";
import {
	BASH_OUTPUT_WAIT_REMOVED_GUIDANCE,
	createBashOutputTool,
} from "../src/core/extensions/builtin/terminal/tools/bash-output.ts";
import type { TerminalToolContext } from "../src/core/extensions/builtin/terminal/tools/context.ts";

/**
 * Consistency gate: no shipped senpi prompt surface may teach the removed
 * bash_output blocking idiom (`wait_for`). The only tolerated mentions are
 * ghost-guidance lines that state the idiom was removed and redirect to the
 * monitor/notification model. Reintroducing a blocking-wait teaching anywhere
 * in these surfaces fails this gate and names the offending line.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CODING_AGENT_ROOT = join(REPO_ROOT, "packages", "coding-agent");

/** Lines mentioning wait_for are allowed only when they are removal guidance. */
const GHOST_GUIDANCE_MARKER = /removed|no longer/i;

/** Lines mentioning tmux are allowed only when they steer away from it. */
const NEGATIVE_GUIDANCE_MARKER = /do not|don't|never/i;

function surfaceLines(name: string, text: string): Array<{ name: string; line: number; text: string }> {
	return text.split("\n").map((line, index) => ({ name, line: index + 1, text: line }));
}

function stubTerminalCtx(): TerminalToolContext {
	return {
		manager: { get: () => undefined },
		cwd: process.cwd(),
		defaultCols: 120,
		defaultRows: 40,
		getEnv: () => process.env,
	} as unknown as TerminalToolContext;
}

/** The prompt surfaces the model actually sees (system-prompt sections + tool schemas). */
function agentFacingSurfaces(): Array<{ name: string; line: number; text: string }> {
	const stubCtx = stubTerminalCtx();
	return [
		...surfaceLines("terminal/prompt.ts TERMINAL_PROMPT_SECTION", TERMINAL_PROMPT_SECTION),
		...surfaceLines("bash-timeout prompt section", buildBashTimeoutPrompt(resolveBashTimeoutDefaults({}))),
		...surfaceLines("terminal bash tool description", createPtyBashTool(stubCtx).description),
		...surfaceLines("bash_output tool description", createBashOutputTool(stubCtx).description),
	];
}

function loadSurfaces(): Array<{ name: string; line: number; text: string }> {
	const stubCtx = stubTerminalCtx();
	const bashOutput = createBashOutputTool(stubCtx);

	return [
		...surfaceLines("terminal/prompt.ts TERMINAL_PROMPT_SECTION", TERMINAL_PROMPT_SECTION),
		...surfaceLines("bash-timeout prompt section", buildBashTimeoutPrompt(resolveBashTimeoutDefaults({}))),
		...surfaceLines("terminal bash tool description", createPtyBashTool(stubCtx).description),
		...surfaceLines("bash_output tool description", bashOutput.description),
		...surfaceLines("bash_output promptSnippet", bashOutput.promptSnippet ?? ""),
		...surfaceLines(
			"packages/coding-agent/docs/terminal-tools.md",
			readFileSync(join(CODING_AGENT_ROOT, "docs", "terminal-tools.md"), "utf8"),
		),
		...surfaceLines(
			".agents/skills/senpi-qa/SKILL.md",
			readFileSync(join(REPO_ROOT, ".agents", "skills", "senpi-qa", "SKILL.md"), "utf8"),
		),
	];
}

describe("stale wait-idiom consistency gate", () => {
	it("no shipped prompt surface teaches the removed wait_for blocking idiom", () => {
		const violations = loadSurfaces().filter(
			({ text }) => text.includes("wait_for") && !GHOST_GUIDANCE_MARKER.test(text),
		);
		expect(
			violations.map(({ name, line, text }) => `${name}:${line}: ${text.trim()}`),
			"stale wait_for blocking teachings found (non-ghost-guidance mentions)",
		).toEqual([]);
	});

	it("the terminal prompt teaches the monitor/notification model instead", () => {
		expect(TERMINAL_PROMPT_SECTION).toContain("monitor(");
		expect(TERMINAL_PROMPT_SECTION.toLowerCase()).toContain("notification");
		expect(TERMINAL_PROMPT_SECTION).not.toContain("wait_for");
	});

	it("the bash tool surface routes waits to the monitor tool", () => {
		const bash = createPtyBashTool(stubTerminalCtx());
		expect(bash.description).toContain("monitor");
	});

	it("no agent-facing terminal surface teaches tmux as the backgrounding mechanism", () => {
		const violations = agentFacingSurfaces().filter(
			({ text }) => /tmux/i.test(text) && !NEGATIVE_GUIDANCE_MARKER.test(text),
		);
		expect(
			violations.map(({ name, line, text }) => `${name}:${line}: ${text.trim()}`),
			"tmux taught as a backgrounding/wait mechanism outside negative guidance",
		).toEqual([]);
	});

	it("the bash_output tool surface no longer advertises blocking", () => {
		const bashOutput = createBashOutputTool(stubTerminalCtx());
		expect(bashOutput.description.toLowerCase()).not.toContain("block until");
		expect(bashOutput.description).not.toContain("wait_for");
		expect(bashOutput.promptSnippet ?? "").not.toContain("wait_for");
	});

	it("the ghost guidance exists so removed-param callers are redirected to monitor", () => {
		expect(BASH_OUTPUT_WAIT_REMOVED_GUIDANCE).toContain("wait_for removed");
		expect(BASH_OUTPUT_WAIT_REMOVED_GUIDANCE).toContain("monitor(");
	});
});
