import type { TipDefinition } from "./types.ts";

export const SUBAGENT_TIPS = [
	{
		id: "workflow-skills.plan",
		bindings: [],
		requiresCommand: "tasks",
		render: () => 'Trigger "ulw plan" to get an explored, decision-complete plan under .omo/plans/.',
	},
	{
		id: "workflow-skills.start-work",
		bindings: [],
		requiresCommand: "tasks",
		render: () => 'Trigger "$start-work <plan-name>" to execute a plan end-to-end in a fresh session.',
	},
	{
		id: "workflow-skills.ultrawork",
		bindings: [],
		requiresCommand: "tasks",
		render: () => 'Trigger "ulw" or "ulw loop" for a long, evidence-driven autonomous run in ultrawork mode.',
	},
	{
		id: "workflow-skills.research",
		bindings: [],
		requiresCommand: "tasks",
		render: () =>
			'Trigger "ulw-research" for a saturating, citation-backed investigation across the codebase, docs, and the web.',
	},
	{
		id: "workflow-skills.hyperplan",
		bindings: [],
		requiresCommand: "tasks",
		render: () => 'Trigger "hyperplan" to have adversarial reviewers attack a plan before you commit to it.',
	},
	{
		id: "workflow-skills.review",
		bindings: [],
		requiresCommand: "tasks",
		render: () => 'Trigger "review work" to run parallel goal, quality, security, and hands-on QA reviews.',
	},
	{
		id: "subagent-categories",
		bindings: [],
		requiresCommand: "tasks",
		render: () =>
			"Delegate by category - quick, deep, ultrabrain, architect, artistry, git, writing - each runs on its own model.",
	},
	{
		id: "subagent-commands",
		bindings: [],
		requiresCommand: "tasks",
		render: () => "Use /tasks to see this session's background subagents, and /task-kill to stop one.",
	},
	{
		id: "subagent-config",
		bindings: [],
		requiresCommand: "tasks",
		render: () => "~/.omo/omo.jsonc maps every subagent category to its model, reasoning effort, and fallback chain.",
	},
	{
		id: "subagent-team",
		bindings: [],
		requiresCommand: "tasks",
		render: () =>
			"Ask for a team when one task needs several agents at once: members share a tasklist and report back to you.",
	},
] satisfies readonly TipDefinition[];
