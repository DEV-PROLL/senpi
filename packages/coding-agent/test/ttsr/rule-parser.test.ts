import { describe, expect, it } from "vitest";

import {
	compileRuleCondition,
	parseRuleFile,
	type RuleFileMeta,
	type SkippedRule,
} from "../../src/core/extensions/builtin/ttsr/rule-parser.ts";
import { matchesPathGlobs, matchesScope, parseScope } from "../../src/core/extensions/builtin/ttsr/scope.ts";
import type { TtsrRule } from "../../src/core/extensions/builtin/ttsr/types.ts";

const META: RuleFileMeta = { name: "fix-failures-now", path: "rules/fix-failures-now.md", source: "project" };

function markdown(lines: readonly string[], body = "body"): string {
	return ["---", ...lines, "---", body].join("\n");
}

function expectRule(result: TtsrRule | SkippedRule): TtsrRule {
	if ("skipped" in result) {
		throw new Error(`expected rule, got skip: ${result.warning}`);
	}
	return result;
}

function expectSkipped(result: TtsrRule | SkippedRule): SkippedRule {
	if (!("skipped" in result)) {
		throw new Error(`expected skip, got rule: ${result.name}`);
	}
	return result;
}

describe("compileRuleCondition", () => {
	it("translates a leading (?i) group into native flags", () => {
		const { regex, warning } = compileRuleCondition("(?i)pre.existing");
		expect(warning).toBeUndefined();
		expect(regex?.flags).toBe("i");
		expect(regex?.test("These are Pre-existing failures")).toBe(true);
	});

	it("passes patterns without a leading flag group through verbatim", () => {
		const { regex } = compileRuleCondition("pre.existing");
		expect(regex?.flags).toBe("");
		expect(regex?.test("pre-existing")).toBe(true);
		expect(regex?.test("PRE-EXISTING")).toBe(false);
	});

	it("ignores mid-pattern (?...) groups", () => {
		const { regex } = compileRuleCondition("foo(?:bar)");
		expect(regex?.flags).toBe("");
		expect(regex?.test("foobar")).toBe(true);
	});

	it("translates combined leading flags", () => {
		const { regex } = compileRuleCondition("(?im)^fail");
		expect(regex?.flags).toBe("im");
		expect(regex?.test("ok\nFAIL here")).toBe(true);
	});

	it("returns null plus a warning for unsupported inline flags", () => {
		const { regex, warning } = compileRuleCondition("(?x)broken");
		expect(regex).toBeNull();
		expect(warning).toContain("(?x)broken");
	});

	it("returns null plus a warning for malformed patterns", () => {
		const { regex, warning } = compileRuleCondition("(unclosed");
		expect(regex).toBeNull();
		expect(typeof warning).toBe("string");
	});
});

describe("parseRuleFile", () => {
	it("parses the reporter rule with a leading (?i) condition and malformed scope quoting", () => {
		const rule = expectRule(
			parseRuleFile(
				markdown([
					"name: fix-failures-now",
					"description: prohibits pre-existing classification.",
					'condition: "(?i)(pre.existing|also fails on master|check.*master.*first)"',
					'scope: "text","thinking"',
				]),
				META,
			),
		);
		expect(rule.condition).toEqual(["(?i)(pre.existing|also fails on master|check.*master.*first)"]);
		expect(rule.scope.allowText).toBe(true);
		expect(rule.scope.allowThinking).toBe(true);
		expect(rule.scope.toolScopes).toEqual([]);
		expect(matchesScope(rule.scope, "thinking")).toBe(true);
		expect(matchesScope(rule.scope, "text")).toBe(true);
		expect(matchesScope(rule.scope, "tool", "edit")).toBe(false);
		const compiled = compileRuleCondition(rule.condition[0] ?? "");
		expect(compiled.regex?.test("The CI failure was 4 pre-existing GPS map VR mismatches")).toBe(true);
		expect(compiled.regex?.test("Everything also fails on master anyway")).toBe(true);
		expect(rule.description).toBe("prohibits pre-existing classification.");
		expect(rule.content).toBe("body");
		expect(rule.path).toBe("rules/fix-failures-now.md");
		expect(rule.interruptMode).toBe("always");
		expect(rule.source).toBe("project");
	});

	it("skips rules without any condition or legacy alias", () => {
		const result = expectSkipped(parseRuleFile(markdown(["description: no trigger here"]), META));
		expect(result.warning).toContain("no condition");
	});

	it("skips a rule with an invalid condition regex while valid siblings still parse", () => {
		const bad = expectSkipped(parseRuleFile(markdown(['condition: "(?x)broken"']), META));
		expect(bad.warning).toContain("invalid condition");
		const good = parseRuleFile(markdown(["condition: good.*pattern"]), { ...META, name: "sibling" });
		expect(expectRule(good).condition).toEqual(["good.*pattern"]);
	});

	it("accepts legacy ttsr_trigger and ttsrTrigger aliases", () => {
		const snake = expectRule(parseRuleFile(markdown(["ttsr_trigger: alpha.*beta"]), META));
		expect(snake.condition).toEqual(["alpha.*beta"]);
		const camel = expectRule(parseRuleFile(markdown(["ttsrTrigger:", "  - one", "  - two"]), META));
		expect(camel.condition).toEqual(["one", "two"]);
	});

	it("infers edit/write tool scopes from file-glob conditions", () => {
		const rule = expectRule(parseRuleFile(markdown(['condition: "*.rs"', "scope: text"]), META));
		expect(rule.condition).toEqual([".*"]);
		expect(rule.scope.allowText).toBe(true);
		expect(rule.scope.toolScopes).toEqual([
			{ toolName: "edit", pathGlob: "*.rs" },
			{ toolName: "write", pathGlob: "*.rs" },
		]);
		expect(matchesScope(rule.scope, "tool", "edit", ["src/main.rs"])).toBe(true);
		expect(matchesScope(rule.scope, "tool", "write", ["main.rs"])).toBe(true);
		expect(matchesScope(rule.scope, "tool", "bash", ["main.rs"])).toBe(false);
		expect(matchesScope(rule.scope, "tool", "edit", ["src/main.ts"])).toBe(false);
	});

	it("defaults scope to text plus any tool when scope is absent", () => {
		const rule = expectRule(parseRuleFile(markdown(["condition: foo"]), META));
		expect(rule.scope.allowText).toBe(true);
		expect(rule.scope.allowThinking).toBe(false);
		expect(matchesScope(rule.scope, "tool", "bash")).toBe(true);
		expect(matchesScope(rule.scope, "tool")).toBe(true);
		expect(matchesScope(rule.scope, "thinking")).toBe(false);
	});

	it("maps globs and interruptMode", () => {
		const rule = expectRule(
			parseRuleFile(markdown(["condition: foo", "globs:", "  - src/**", "interruptMode: never"]), META),
		);
		expect(rule.globs).toEqual(["src/**"]);
		expect(rule.interruptMode).toBe("never");
		expect(matchesPathGlobs(rule.globs ?? [], ["src/a.ts"])).toBe(true);
		expect(matchesPathGlobs(rule.globs ?? [], ["test/a.ts"])).toBe(false);
	});

	it("skips rules whose scope excludes every stream", () => {
		const result = expectSkipped(parseRuleFile(markdown(["condition: foo", "scope: '!!!'"]), META));
		expect(result.warning).toContain("scope");
	});
});

describe("parseScope", () => {
	it("returns the default scope for no tokens", () => {
		expect(parseScope([])).toEqual({ allowText: true, allowThinking: false, toolScopes: [{ toolName: "*" }] });
	});

	it("parses text, thinking, and tool keywords case-insensitively", () => {
		expect(parseScope(["TEXT", " Thinking "])).toEqual({
			allowText: true,
			allowThinking: true,
			toolScopes: [],
		});
		expect(parseScope(["toolcall"]).toolScopes).toEqual([{ toolName: "*" }]);
	});

	it("parses tool tokens with optional path globs", () => {
		expect(parseScope(["tool:Edit(*.ts)", "write", "tool(*.md)"]).toolScopes).toEqual([
			{ toolName: "edit", pathGlob: "*.ts" },
			{ toolName: "write" },
			{ toolName: "*", pathGlob: "*.md" },
		]);
	});

	it("drops invalid tokens", () => {
		expect(parseScope(["text", "!!!"]).allowText).toBe(true);
		expect(parseScope(["!!!"])).toEqual({ allowText: false, allowThinking: false, toolScopes: [] });
	});
});

describe("matchesScope", () => {
	const editRs = parseScope(["tool:edit(*.rs)"]);

	it("gates tool streams by name and path glob", () => {
		expect(matchesScope(editRs, "tool", "edit", ["src/main.rs"])).toBe(true);
		expect(matchesScope(editRs, "tool", "write", ["src/main.rs"])).toBe(false);
		expect(matchesScope(editRs, "tool", "edit", ["src/main.ts"])).toBe(false);
		expect(matchesScope(editRs, "tool", "edit")).toBe(false);
	});

	it("matches globs against the full path and the basename", () => {
		const scoped = parseScope(["tool:edit(src/**/*.rs)"]);
		expect(matchesScope(scoped, "tool", "edit", ["src/a/b.rs"])).toBe(true);
		expect(matchesScope(scoped, "tool", "edit", ["b.rs"])).toBe(false);
	});

	it("normalizes windows separators before matching", () => {
		expect(matchesScope(editRs, "tool", "edit", ["src\\main.rs"])).toBe(true);
	});

	it("matches any tool for the wildcard scope", () => {
		const anyTool = parseScope(["tool"]);
		expect(matchesScope(anyTool, "tool", "bash")).toBe(true);
		expect(matchesScope(anyTool, "tool")).toBe(true);
		expect(matchesScope(anyTool, "text")).toBe(false);
	});
});

describe("matchesPathGlobs", () => {
	it("allows everything when no globs are given", () => {
		expect(matchesPathGlobs([])).toBe(true);
	});

	it("requires at least one glob to match a path", () => {
		expect(matchesPathGlobs(["*.rs"], ["src/main.rs"])).toBe(true);
		expect(matchesPathGlobs(["*.rs"], [])).toBe(false);
		expect(matchesPathGlobs(["*.rs"], ["src/main.ts"])).toBe(false);
	});
});
