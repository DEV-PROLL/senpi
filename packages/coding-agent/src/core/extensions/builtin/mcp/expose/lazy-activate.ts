// Lazy tool activation for code-mode (eval) callers.
//
// An eval cell that names an MCP tool held inactive by SEARCH-mode exposure used
// to fail with `inactive_tool`, even though tool_search may promote that exact
// tool. Eligibility is therefore the tier-B searchable catalog and nothing else:
// permission-denied tools, `list_changed` rug-pull additions, removed-tool
// tombstones, and model-gated tools (look_at / read_video) are never eligible.
// Activation is delegated to the tier-B `activate()` path so stub-swap, name
// filtering, and active-set ordering keep their existing semantics.

export interface LazySearchableTool {
	readonly name: string;
}

export interface LazyActivationState {
	readonly searchable: readonly LazySearchableTool[];
	readonly active: readonly string[];
}

export interface LazyToolActivatorDeps {
	readonly getSearchable: () => readonly LazySearchableTool[];
	readonly getActiveTools: () => readonly string[];
	readonly activate: (names: readonly string[]) => void;
}

export function resolveLazyActivationTargets(
	requested: readonly string[],
	state: LazyActivationState,
): readonly string[] {
	const eligible = new Set(state.searchable.map((tool) => tool.name));
	const active = new Set(state.active);
	const targets: string[] = [];
	for (const name of requested) {
		if (!eligible.has(name) || active.has(name) || targets.includes(name)) continue;
		targets.push(name);
	}
	return targets;
}

export function createLazyToolActivator(deps: LazyToolActivatorDeps): (toolName: string) => boolean {
	return (toolName: string): boolean => {
		const targets = resolveLazyActivationTargets([toolName], {
			searchable: deps.getSearchable(),
			active: deps.getActiveTools(),
		});
		if (targets.length === 0) return false;
		deps.activate(targets);
		return true;
	};
}
