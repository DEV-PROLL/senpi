import picomatch from "picomatch";

import type { TtsrScope, TtsrStreamSource, TtsrToolScope } from "./types.ts";

export const ANY_TOOL_NAME = "*";

const PICOMATCH_OPTIONS = { dot: true };

const TOOL_SCOPE_TOKEN_PATTERN =
	/^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i;

const DEFAULT_SCOPE: TtsrScope = {
	allowText: true,
	allowThinking: false,
	toolScopes: [{ toolName: ANY_TOOL_NAME }],
};

type PathMatcher = (path: string) => boolean;

function parseToolScopeToken(token: string): TtsrToolScope | undefined {
	const groups = TOOL_SCOPE_TOKEN_PATTERN.exec(token)?.groups;
	if (groups === undefined) {
		return undefined;
	}
	const hasToolPrefix = groups.prefix !== undefined;
	const rawName = groups.tool ?? (hasToolPrefix ? undefined : groups.bare);
	const toolName = rawName?.trim().toLowerCase();
	const pathGlob = groups.path?.trim();
	const hasGlob = pathGlob !== undefined && pathGlob.length > 0;
	if (toolName === undefined || toolName.length === 0) {
		return hasGlob ? { toolName: ANY_TOOL_NAME, pathGlob } : { toolName: ANY_TOOL_NAME };
	}
	return hasGlob ? { toolName, pathGlob } : { toolName };
}

function toolScopeKey(toolScope: TtsrToolScope): string {
	return `${toolScope.toolName}(${toolScope.pathGlob ?? ""})`;
}

export function parseScope(tokens: readonly string[]): TtsrScope {
	if (tokens.length === 0) {
		return {
			allowText: DEFAULT_SCOPE.allowText,
			allowThinking: DEFAULT_SCOPE.allowThinking,
			toolScopes: [...DEFAULT_SCOPE.toolScopes],
		};
	}
	let allowText = false;
	let allowThinking = false;
	const toolScopes: TtsrToolScope[] = [];
	const seenToolScopes = new Set<string>();
	const pushToolScope = (toolScope: TtsrToolScope): void => {
		const key = toolScopeKey(toolScope);
		if (seenToolScopes.has(key)) {
			return;
		}
		seenToolScopes.add(key);
		toolScopes.push(toolScope);
	};
	for (const rawToken of tokens) {
		const token = rawToken.trim();
		if (token.length === 0) {
			continue;
		}
		const normalized = token.toLowerCase();
		if (normalized === "text") {
			allowText = true;
			continue;
		}
		if (normalized === "thinking") {
			allowThinking = true;
			continue;
		}
		if (normalized === "tool" || normalized === "toolcall") {
			pushToolScope({ toolName: ANY_TOOL_NAME });
			continue;
		}
		const toolScope = parseToolScopeToken(token);
		if (toolScope === undefined) {
			continue;
		}
		pushToolScope(toolScope);
	}
	return { allowText, allowThinking, toolScopes };
}

export function hasReachableScope(scope: TtsrScope): boolean {
	return scope.allowText || scope.allowThinking || scope.toolScopes.length > 0;
}

function normalizePath(pathValue: string): string {
	return pathValue.replaceAll("\\", "/");
}

function compileGlob(pattern: string): PathMatcher | undefined {
	try {
		return picomatch(pattern, PICOMATCH_OPTIONS);
	} catch {
		return undefined;
	}
}

function matchesAnyPath(matcher: PathMatcher, filePaths: readonly string[] | undefined): boolean {
	if (filePaths === undefined || filePaths.length === 0) {
		return false;
	}
	for (const filePath of filePaths) {
		const normalized = normalizePath(filePath);
		if (matcher(normalized)) {
			return true;
		}
		const slashIndex = normalized.lastIndexOf("/");
		const basename = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
		if (basename !== normalized && matcher(basename)) {
			return true;
		}
	}
	return false;
}

export function matchesScope(
	scope: TtsrScope,
	source: TtsrStreamSource,
	toolName?: string,
	filePaths?: readonly string[],
): boolean {
	if (source === "text") {
		return scope.allowText;
	}
	if (source === "thinking") {
		return scope.allowThinking;
	}
	const normalizedToolName = toolName?.trim().toLowerCase();
	for (const toolScope of scope.toolScopes) {
		if (toolScope.toolName !== ANY_TOOL_NAME && toolScope.toolName.toLowerCase() !== normalizedToolName) {
			continue;
		}
		if (toolScope.pathGlob !== undefined) {
			const matcher = compileGlob(toolScope.pathGlob);
			if (matcher === undefined || !matchesAnyPath(matcher, filePaths)) {
				continue;
			}
		}
		return true;
	}
	return false;
}

export function matchesPathGlobs(globs: readonly string[], filePaths?: readonly string[]): boolean {
	if (globs.length === 0) {
		return true;
	}
	for (const glob of globs) {
		const matcher = compileGlob(glob);
		if (matcher !== undefined && matchesAnyPath(matcher, filePaths)) {
			return true;
		}
	}
	return false;
}
