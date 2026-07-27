import type { Keybinding } from "../../../core/keybindings.ts";

export interface TipDefinition {
	id: string;
	bindings: readonly Keybinding[];
	render(keys: (binding: Keybinding) => string): string;
}

export const TIP_DEFINITIONS = [
	{
		id: "thinking-level",
		bindings: ["app.thinking.cycle"],
		render: (keys) => `Use ${keys("app.thinking.cycle")} to cycle the model's thinking level.`,
	},
	{
		id: "favorite-model-rotation",
		bindings: ["app.model.cycleForward", "app.model.cycleBackward"],
		render: (keys) =>
			`Rotate through favorite models with ${keys("app.model.cycleForward")}; go backward with ${keys("app.model.cycleBackward")}.`,
	},
	{
		id: "model-selector-favorites",
		bindings: ["app.model.select", "app.models.toggleFavorite"],
		render: (keys) =>
			`Open the model selector with ${keys("app.model.select")}, then use ${keys("app.models.toggleFavorite")} to toggle the highlighted favorite.`,
	},
	{
		id: "queue-follow-up",
		bindings: ["app.message.followUp"],
		render: (keys) =>
			`While the agent is working, use ${keys("app.message.followUp")} to queue a follow-up for after it finishes.`,
	},
	{
		id: "edit-queued-message",
		bindings: ["app.message.dequeue"],
		render: (keys) => `Use ${keys("app.message.dequeue")} to bring queued messages back for editing.`,
	},
	{
		id: "prompt-history",
		bindings: ["app.history.search"],
		render: (keys) => `Search prompt history across sessions with ${keys("app.history.search")}.`,
	},
	{
		id: "external-editor",
		bindings: ["app.editor.external"],
		render: (keys) => `Open the current prompt in your external editor with ${keys("app.editor.external")}.`,
	},
	{
		id: "expand-tool-output",
		bindings: ["app.tools.expand"],
		render: (keys) => `Collapse or expand tool output with ${keys("app.tools.expand")}.`,
	},
	{
		id: "thinking-blocks",
		bindings: ["app.thinking.toggle"],
		render: (keys) => `Collapse or expand thinking blocks with ${keys("app.thinking.toggle")}.`,
	},
	{
		id: "paste-image",
		bindings: ["app.clipboard.pasteImage"],
		render: (keys) => `Paste an image from the clipboard with ${keys("app.clipboard.pasteImage")}.`,
	},
	{
		id: "copy-message",
		bindings: ["app.message.copy"],
		render: (keys) => `Copy the latest assistant message with ${keys("app.message.copy")}.`,
	},
	{
		id: "input-newline",
		bindings: ["tui.input.newLine"],
		render: (keys) => `Insert a newline without sending with ${keys("tui.input.newLine")}.`,
	},
	{
		id: "favorite-models-command",
		bindings: [],
		render: () => "Use /favorite-models to choose and reorder the models in your rotation.",
	},
	{
		id: "help-command",
		bindings: [],
		render: () => "Use /help to see available commands and guidance.",
	},
	{
		id: "keybindings-command",
		bindings: [],
		render: () => "Use /keybindings to review and customize keyboard shortcuts.",
	},
	{
		id: "tree-command",
		bindings: [],
		render: () => "Use /tree to revisit earlier points and switch between session branches.",
	},
	{
		id: "fork-command",
		bindings: [],
		render: () => "Use /fork to create a separate session from an earlier user message.",
	},
	{
		id: "bash-prefixes",
		bindings: [],
		render: () => "Prefix a prompt with ! to run bash, or !! to run bash without adding its output to model context.",
	},
	{
		id: "drag-drop-files",
		bindings: [],
		render: () => "Drag and drop files into the terminal to add their paths to your prompt.",
	},
	{
		id: "workflow-skills.plan",
		bindings: [],
		render: () => 'Trigger "ulw plan" to get an explored, decision-complete plan under .omo/plans/.',
	},
	{
		id: "workflow-skills.start-work",
		bindings: [],
		render: () => 'Trigger "$start-work <plan-name>" to execute a plan end-to-end in a fresh session.',
	},
	{
		id: "workflow-skills.ultrawork",
		bindings: [],
		render: () => 'Trigger "ulw" or "ulw loop" for a long, evidence-driven autonomous run in ultrawork mode.',
	},
	{
		id: "workflow-skills.research",
		bindings: [],
		render: () =>
			'Trigger "ulw-research" for a saturating, citation-backed investigation across the codebase, docs, and the web.',
	},
	{
		id: "workflow-skills.hyperplan",
		bindings: [],
		render: () => 'Trigger "hyperplan" to have adversarial reviewers attack a plan before you commit to it.',
	},
	{
		id: "workflow-skills.review",
		bindings: [],
		render: () => 'Trigger "review work" to run parallel goal, quality, security, and hands-on QA reviews.',
	},
] satisfies readonly TipDefinition[];
