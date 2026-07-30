import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";

import { parseRuleFile } from "./rule-parser.ts";
import type { TtsrRule } from "./types.ts";

const SENPI_DIR_NAME = ".senpi";
const TTSR_DIR_NAME = "ttsr";
const MARKDOWN_EXTENSION = ".md";
const MAX_PARENT_SEARCH_DEPTH = 100;

export interface TtsrDiscoveryResult {
	readonly rules: TtsrRule[];
	readonly warnings: string[];
}

type RuleOrigin = "project" | "global";

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function findProjectRoot(cwd: string, homeDir: string): Promise<string> {
	const normalizedHome = normalize(homeDir);
	let current = normalize(cwd);
	for (let depth = 0; depth <= MAX_PARENT_SEARCH_DEPTH; depth += 1) {
		if (current === normalizedHome) {
			return cwd;
		}
		if (await isDirectory(join(current, SENPI_DIR_NAME))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return cwd;
		}
		current = parent;
	}
	return cwd;
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(MARKDOWN_EXTENSION))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

async function loadRules(dir: string, source: RuleOrigin): Promise<TtsrDiscoveryResult> {
	const rules: TtsrRule[] = [];
	const warnings: string[] = [];
	for (const fileName of await listMarkdownFiles(dir)) {
		const path = join(dir, fileName);
		const name = fileName.slice(0, fileName.length - MARKDOWN_EXTENSION.length);
		let markdown: string;
		try {
			markdown = await readFile(path, "utf-8");
		} catch {
			warnings.push(`rule "${name}" at ${path} could not be read, skipping`);
			continue;
		}
		const parsed = parseRuleFile(markdown, { name, path, source });
		if ("skipped" in parsed) {
			warnings.push(parsed.warning);
			continue;
		}
		rules.push(parsed);
	}
	return { rules, warnings };
}

export async function discoverTtsrRules(cwd: string, homeDir?: string): Promise<TtsrDiscoveryResult> {
	const resolvedHome = homeDir ?? homedir();
	const globalDir = join(resolvedHome, SENPI_DIR_NAME, TTSR_DIR_NAME);
	const projectRoot = await findProjectRoot(cwd, resolvedHome);
	const projectDir = join(projectRoot, SENPI_DIR_NAME, TTSR_DIR_NAME);
	const globalResult = await loadRules(globalDir, "global");
	const projectResult =
		projectDir === globalDir ? { rules: [], warnings: [] } : await loadRules(projectDir, "project");
	const projectNames = new Set(projectResult.rules.map((rule) => rule.name));
	const rules = [...globalResult.rules.filter((rule) => !projectNames.has(rule.name)), ...projectResult.rules];
	return { rules, warnings: [...globalResult.warnings, ...projectResult.warnings] };
}

function isDirectorySync(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function findProjectRootSync(cwd: string, homeDir: string): string {
	const normalizedHome = normalize(homeDir);
	let current = normalize(cwd);
	for (let depth = 0; depth <= MAX_PARENT_SEARCH_DEPTH; depth += 1) {
		if (current === normalizedHome) {
			return cwd;
		}
		if (isDirectorySync(join(current, SENPI_DIR_NAME))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return cwd;
		}
		current = parent;
	}
	return cwd;
}

function listMarkdownFilesSync(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(MARKDOWN_EXTENSION))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

function loadRulesSync(dir: string, source: RuleOrigin): TtsrDiscoveryResult {
	const rules: TtsrRule[] = [];
	const warnings: string[] = [];
	for (const fileName of listMarkdownFilesSync(dir)) {
		const path = join(dir, fileName);
		const name = fileName.slice(0, fileName.length - MARKDOWN_EXTENSION.length);
		let markdown: string;
		try {
			markdown = readFileSync(path, "utf-8");
		} catch {
			warnings.push(`rule "${name}" at ${path} could not be read, skipping`);
			continue;
		}
		const parsed = parseRuleFile(markdown, { name, path, source });
		if ("skipped" in parsed) {
			warnings.push(parsed.warning);
			continue;
		}
		rules.push(parsed);
	}
	return { rules, warnings };
}

export function discoverTtsrRulesSync(cwd: string, homeDir?: string): TtsrDiscoveryResult {
	const resolvedHome = homeDir ?? homedir();
	const globalDir = join(resolvedHome, SENPI_DIR_NAME, TTSR_DIR_NAME);
	const projectRoot = findProjectRootSync(cwd, resolvedHome);
	const projectDir = join(projectRoot, SENPI_DIR_NAME, TTSR_DIR_NAME);
	const globalResult = loadRulesSync(globalDir, "global");
	const projectResult = projectDir === globalDir ? { rules: [], warnings: [] } : loadRulesSync(projectDir, "project");
	const projectNames = new Set(projectResult.rules.map((rule) => rule.name));
	const rules = [...globalResult.rules.filter((rule) => !projectNames.has(rule.name)), ...projectResult.rules];
	return { rules, warnings: [...globalResult.warnings, ...projectResult.warnings] };
}
