import { describe, expect, it } from "vitest";
import {
	claudeCodeExecutableCandidates,
	resolveClaudeCodeExecutable,
	type ExecutableDeps,
} from "../src/core/extensions/builtin/claude-agent-sdk/executable.ts";

function makeDeps(overrides: Partial<ExecutableDeps>): ExecutableDeps {
	return {
		platform: "darwin",
		arch: "arm64",
		env: () => undefined,
		resolve: () => {
			throw new Error("not found");
		},
		...overrides,
	};
}

describe("claudeCodeExecutableCandidates", () => {
	it("uses the platform/arch package on darwin-arm64", () => {
		expect(claudeCodeExecutableCandidates("darwin", "arm64")).toEqual([
			"@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
		]);
	});

	it("uses the platform/arch package on darwin-x64", () => {
		expect(claudeCodeExecutableCandidates("darwin", "x64")).toEqual([
			"@anthropic-ai/claude-agent-sdk-darwin-x64/claude",
		]);
	});

	it("tries musl first, then glibc on linux-x64", () => {
		expect(claudeCodeExecutableCandidates("linux", "x64")).toEqual([
			"@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude",
			"@anthropic-ai/claude-agent-sdk-linux-x64/claude",
		]);
	});

	it("tries musl first, then glibc on linux-arm64", () => {
		expect(claudeCodeExecutableCandidates("linux", "arm64")).toEqual([
			"@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude",
			"@anthropic-ai/claude-agent-sdk-linux-arm64/claude",
		]);
	});

	it("appends .exe on win32", () => {
		expect(claudeCodeExecutableCandidates("win32", "x64")).toEqual([
			"@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
		]);
	});
});

describe("resolveClaudeCodeExecutable", () => {
	it("honors CLAUDE_CODE_EXECUTABLE before anything else", () => {
		const deps = makeDeps({
			env: (name) => (name === "CLAUDE_CODE_EXECUTABLE" ? "/custom/claude" : undefined),
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe("/custom/claude");
	});

	it("resolves the first candidate that exists", () => {
		const seen: string[] = [];
		const deps = makeDeps({
			platform: "linux",
			arch: "x64",
			resolve: (spec) => {
				seen.push(spec);
				if (spec.includes("musl")) throw new Error("not found");
				return `/resolved/${spec}`;
			},
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe("/resolved/@anthropic-ai/claude-agent-sdk-linux-x64/claude");
		expect(seen).toEqual([
			"@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude",
			"@anthropic-ai/claude-agent-sdk-linux-x64/claude",
		]);
	});

	it("prefers the compiled-Bun extraction lane when running compiled", () => {
		const deps = makeDeps({
			isCompiledBun: () => true,
			extractFromBunfs: (embedded) => `/extracted${embedded}`,
			resolve: (spec) => `/embedded/${spec}`,
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe(
			"/extracted/embedded/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
		);
	});

	it("falls back to the node_modules probe when extraction throws", () => {
		const deps = makeDeps({
			isCompiledBun: () => true,
			extractFromBunfs: () => {
				throw new Error("not embedded");
			},
			resolve: (spec) => `/resolved/${spec}`,
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe("/resolved/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude");
	});

	it("throws guidance naming both remedies when nothing resolves", () => {
		const deps = makeDeps({ platform: "linux", arch: "arm64" });
		expect(() => resolveClaudeCodeExecutable(deps)).toThrowError(
			/--omit=optional[\s\S]*CLAUDE_CODE_EXECUTABLE/,
		);
	});
});
