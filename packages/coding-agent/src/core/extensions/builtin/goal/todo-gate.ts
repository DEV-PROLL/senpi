import type { SessionEntry } from "../../../session-manager.ts";
import { getLatestPhasesFromBranchEntries, isIncompleteTodo } from "../todotools/state.ts";

const MAX_LISTED_TASKS = 5;

/**
 * Contents of every non-terminal (pending / in_progress) task in the thread's
 * latest todo list. The goal builtin refuses to mark a goal complete while any
 * of these remain: an open todo task is remaining work by definition.
 */
export function openTodoTaskContents(entries: SessionEntry[]): string[] {
	return getLatestPhasesFromBranchEntries(entries)
		.flatMap((phase) => phase.tasks)
		.filter(isIncompleteTodo)
		.map((task) => task.content);
}

export function openTodoCompletionError(openTasks: readonly string[]): string {
	const listed = openTasks
		.slice(0, MAX_LISTED_TASKS)
		.map((task) => `"${task}"`)
		.join(", ");
	const suffix = openTasks.length > MAX_LISTED_TASKS ? ` and ${openTasks.length - MAX_LISTED_TASKS} more` : "";
	return (
		`cannot mark the goal complete: ${openTasks.length} open todo task(s) remain: ${listed}${suffix}. ` +
		"Finish each task and mark it done, or drop tasks that are genuinely no longer needed, " +
		"then run the completion audit again and retry update_goal."
	);
}
