export interface CompiledCondition {
	readonly regex: RegExp | null;
	readonly warning?: string;
}

const INLINE_FLAG_PREFIX = /^\(\?([a-z]+)\)/;
const TRANSLATABLE_INLINE_FLAGS = /^[ims]+$/;

export function compileRuleCondition(condition: string): CompiledCondition {
	const match = INLINE_FLAG_PREFIX.exec(condition);
	const flagText = match?.[1];
	try {
		if (match !== null && flagText !== undefined && TRANSLATABLE_INLINE_FLAGS.test(flagText)) {
			const flags = Array.from(new Set(flagText)).join("");
			return { regex: new RegExp(condition.slice(match[0].length), flags) };
		}
		return { regex: new RegExp(condition) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { regex: null, warning: `invalid condition "${condition}": ${message}` };
	}
}
