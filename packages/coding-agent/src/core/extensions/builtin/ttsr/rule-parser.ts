import { compileRuleCondition } from "./rule-condition.ts";

export { compileRuleCondition } from "./rule-condition.ts";
export type { CompiledCondition } from "./rule-condition.ts";

import { parse as parseYaml } from "yaml";

import { hasReachableScope, parseScope } from "./scope.ts";
import type { TtsrInterruptMode, TtsrRule } from "./types.ts";

export interface RuleFileMeta {
	readonly name: string;
	readonly path?: string;
	readonly source: TtsrRule["source"];
}

export interface SkippedRule {
	readonly skipped: true;
	readonly name: string;
	readonly warning: string;
}

interface ParsedFrontmatter {
	readonly fields: Record<string, unknown>;
	readonly body: string;
}

const FRONTMATTER_FENCE = "---";
const CLOSING_FENCE_PATTERN = "\n---";
const FALLBACK_KEY_VALUE = /^([\w-]+):\s*(.*)$/;
const CONDITION_GLOB_SCOPE_TOOLS = ["edit", "write"] as const;
const CATCH_ALL_CONDITION = ".*";

const REGEX_META_CHARS = /[\\^$+|()]/;
const GLOB_META_CHARS = /[?*[\]{}]/;
const EXTENSION_GLOB = /^\*\.[^\s/]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseFallbackFields(metadata: string): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const line of metadata.split("\n")) {
		const match = FALLBACK_KEY_VALUE.exec(line);
		const key = match?.[1];
		if (key === undefined) {
			continue;
		}
		const raw = (match?.[2] ?? "").trim();
		if (raw.length === 0) {
			fields[key] = raw;
			continue;
		}
		try {
			const parsed: unknown = parseYaml(raw);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				fields[key] = parsed;
			} else {
				fields[key] = raw;
			}
		} catch {
			fields[key] = raw;
		}
	}
	return fields;
}

function parseFrontmatterFields(metadata: string): Record<string, unknown> {
	try {
		const loaded: unknown = parseYaml(metadata);
		return isRecord(loaded) ? loaded : {};
	} catch {
		return parseFallbackFields(metadata);
	}
}

function splitFrontmatter(markdown: string): ParsedFrontmatter {
	const normalized = markdown.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith(FRONTMATTER_FENCE)) {
		return { fields: {}, body: normalized };
	}
	const endIndex = normalized.indexOf(CLOSING_FENCE_PATTERN, FRONTMATTER_FENCE.length);
	if (endIndex === -1) {
		return { fields: {}, body: normalized };
	}
	const metadata = normalized.slice(FRONTMATTER_FENCE.length + 1, endIndex);
	const body = normalized.slice(endIndex + CLOSING_FENCE_PATTERN.length).trim();
	return { fields: parseFrontmatterFields(metadata), body };
}

function normalizeStringList(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const token = value.trim();
		return token.length > 0 ? [token] : undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}
	const tokens = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	if (tokens.length === 0) {
		return undefined;
	}
	return Array.from(new Set(tokens));
}

function splitScopeTokens(value: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let parenDepth = 0;
	let bracketDepth = 0;
	let braceDepth = 0;
	let quote: string | undefined;
	for (let index = 0; index < value.length; index++) {
		const char = value.charAt(index);
		if (quote !== undefined) {
			current += char;
			if (char === quote && value.charAt(index - 1) !== "\\") {
				quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "(") {
			parenDepth += 1;
		} else if (char === ")") {
			parenDepth = Math.max(0, parenDepth - 1);
		} else if (char === "[") {
			bracketDepth += 1;
		} else if (char === "]") {
			bracketDepth = Math.max(0, bracketDepth - 1);
		} else if (char === "{") {
			braceDepth += 1;
		} else if (char === "}") {
			braceDepth = Math.max(0, braceDepth - 1);
		} else if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
			const token = current.trim();
			if (token.length > 0) {
				tokens.push(token);
			}
			current = "";
			continue;
		}
		current += char;
	}
	const tail = current.trim();
	if (tail.length > 0) {
		tokens.push(tail);
	}
	return tokens;
}

function stripSurroundingQuotes(token: string): string {
	const first = token.charAt(0);
	if (token.length >= 2 && (first === '"' || first === "'") && token.charAt(token.length - 1) === first) {
		return token.slice(1, -1).trim();
	}
	return token;
}

function normalizeScopeField(value: unknown): string[] | undefined {
	const normalized = normalizeStringList(value);
	if (normalized === undefined) {
		return undefined;
	}
	const tokens = normalized
		.flatMap(splitScopeTokens)
		.map(stripSurroundingQuotes)
		.filter((item) => item.length > 0);
	if (tokens.length === 0) {
		return undefined;
	}
	return Array.from(new Set(tokens));
}

function isLikelyFileGlob(value: string): boolean {
	const token = value.trim();
	if (token.length === 0) {
		return false;
	}
	if (REGEX_META_CHARS.test(token)) {
		return false;
	}
	if (!GLOB_META_CHARS.test(token)) {
		return false;
	}
	if (token.includes("/")) {
		return true;
	}
	return EXTENSION_GLOB.test(token);
}

export function parseRuleFile(markdown: string, meta: RuleFileMeta): TtsrRule | SkippedRule {
	const { fields, body } = splitFrontmatter(markdown);
	const rawCondition = fields.condition ?? fields.ttsr_trigger ?? fields.ttsrTrigger;
	const parsedCondition = normalizeStringList(rawCondition);
	const parsedScope = normalizeScopeField(fields.scope);
	const inferredScopeTokens: string[] = [];
	const condition: string[] = [];
	for (const token of parsedCondition ?? []) {
		if (isLikelyFileGlob(token)) {
			for (const toolName of CONDITION_GLOB_SCOPE_TOOLS) {
				inferredScopeTokens.push(`tool:${toolName}(${token})`);
			}
			continue;
		}
		condition.push(token);
	}
	if (condition.length === 0 && inferredScopeTokens.length > 0) {
		condition.push(CATCH_ALL_CONDITION);
	}
	if (condition.length === 0) {
		return {
			skipped: true,
			name: meta.name,
			warning: `rule "${meta.name}" has no condition or legacy ttsr_trigger alias, skipping`,
		};
	}
	for (const pattern of condition) {
		const compiled = compileRuleCondition(pattern);
		if (compiled.regex === null) {
			return {
				skipped: true,
				name: meta.name,
				warning: `rule "${meta.name}" skipped: ${compiled.warning ?? "invalid condition"}`,
			};
		}
	}
	const scope = parseScope([...(parsedScope ?? []), ...inferredScopeTokens]);
	if (!hasReachableScope(scope)) {
		return {
			skipped: true,
			name: meta.name,
			warning: `rule "${meta.name}" scope excludes every stream, skipping`,
		};
	}
	const description = typeof fields.description === "string" ? fields.description : undefined;
	const globs = normalizeStringList(fields.globs);
	const interruptMode: TtsrInterruptMode = fields.interruptMode === "never" ? "never" : "always";
	return {
		name: meta.name,
		...(meta.path !== undefined ? { path: meta.path } : {}),
		content: body,
		...(description !== undefined ? { description } : {}),
		...(globs !== undefined ? { globs } : {}),
		condition: Array.from(new Set(condition)),
		scope,
		interruptMode,
		source: meta.source,
	};
}
