import {
	PROJECT_RULES_END_MARKER,
	PROJECT_RULES_HEADING,
	PROJECT_RULES_REGION_END_MARKER,
	PROJECT_RULES_REGION_START_MARKER,
	PROJECT_RULES_START_MARKER,
} from "./constants.ts";
import { truncateBudget, truncateRule } from "./truncator.ts";
import type { LoadedRule } from "./types.ts";

export interface FormatOptions {
	maxRuleChars: number;
	maxResultChars: number;
}

type TruncatedRule = {
	path: string;
	relativePath: string;
	body: string;
};

function formatRule(rule: TruncatedRule): string {
	return `Instructions from: ${rule.path}\n${rule.body}`;
}

function formatWithinResultBudget(
	rules: ReadonlyArray<LoadedRule>,
	options: FormatOptions,
	render: (truncatedRules: ReadonlyArray<TruncatedRule>) => string,
): string {
	let bodyBudget = options.maxResultChars;
	while (bodyBudget > 0) {
		const truncatedRules = truncateRules(rules, { ...options, maxResultChars: bodyBudget });
		if (truncatedRules.length === 0) return "";

		const block = render(truncatedRules);
		const overflow = block.length - options.maxResultChars;
		if (overflow <= 0) return block;
		bodyBudget = Math.max(0, bodyBudget - overflow);
	}
	return "";
}

function truncateRules(rules: ReadonlyArray<LoadedRule>, options: FormatOptions): TruncatedRule[] {
	const perRuleTruncated = rules.map((rule) => ({
		path: rule.path,
		relativePath: rule.relativePath,
		body: truncateRule(rule.body, { maxChars: options.maxRuleChars, relativePath: rule.relativePath }).body,
	}));
	const budgetedRules = truncateBudget({
		rules: perRuleTruncated.map((rule) => ({ body: rule.body, relativePath: rule.relativePath })),
		maxResultChars: options.maxResultChars,
	});
	const truncatedRules: TruncatedRule[] = [];

	for (let index = 0; index < budgetedRules.length; index += 1) {
		const sourceRule = perRuleTruncated[index];
		const budgetedRule = budgetedRules[index];
		if (sourceRule === undefined || budgetedRule === undefined) {
			continue;
		}

		truncatedRules.push({
			path: sourceRule.path,
			relativePath: budgetedRule.relativePath,
			body: budgetedRule.body,
		});
	}

	return truncatedRules;
}

export function formatStaticBlock(rules: ReadonlyArray<LoadedRule>, options: FormatOptions): string {
	if (rules.length === 0) {
		return "";
	}

	return formatWithinResultBudget(rules, options, (truncatedRules) => {
		const body = neutralizeEnvelopeMarkers(
			`${PROJECT_RULES_HEADING}\n${truncatedRules.map(formatRule).join("\n\n")}`,
		);
		const envelope = `${PROJECT_RULES_START_MARKER}\n${body}\n${PROJECT_RULES_END_MARKER}`;
		return `\n\n${PROJECT_RULES_REGION_START_MARKER}\n${envelope}\n${PROJECT_RULES_REGION_END_MARKER}`;
	});
}

/**
 * A raw region sentinel inside a rule would terminate extraction early and drop every rule after it;
 * a raw semantic marker would instead corrupt the envelope structure the model reads.
 */
function neutralizeEnvelopeMarkers(text: string): string {
	return text
		.replaceAll(PROJECT_RULES_REGION_START_MARKER, "&lt;!--senpi:project-rules:1:start--&gt;")
		.replaceAll(PROJECT_RULES_REGION_END_MARKER, "&lt;!--senpi:project-rules:1:end--&gt;")
		.replaceAll(PROJECT_RULES_START_MARKER, "&lt;project_rules&gt;")
		.replaceAll(PROJECT_RULES_END_MARKER, "&lt;/project_rules&gt;");
}

export function formatDynamicBlock(
	rules: ReadonlyArray<LoadedRule>,
	targetRelativePath: string,
	options: FormatOptions,
): string {
	if (rules.length === 0) {
		return "";
	}

	return formatWithinResultBudget(
		rules,
		options,
		(truncatedRules) =>
			`\n\nAdditional project instructions matched for ${targetRelativePath}:\n\n${truncatedRules
				.map(formatRule)
				.join("\n\n")}`,
	);
}
