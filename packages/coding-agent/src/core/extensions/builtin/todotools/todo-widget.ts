// Ported and adapted from oh-my-pi's todo tool (MIT License).
// Copyright (c) 2025 Mario Zechner
// Copyright (c) 2025-2026 Can Bölük
// https://github.com/can1357/oh-my-pi

import { getTodoMarker, sanitizeTodoText } from "./todo-format.ts";
import { nextActionableTask } from "./todo-query.ts";
import type { TodoItem, TodoPhase } from "./todo-types.ts";

const TODO_WIDGET_MAX_LINES = 10;
const TODO_WIDGET_HEADER_LINES = 2;
const TODO_WIDGET_RECENT_TASKS = 2;

function getActivePhase(phases: readonly TodoPhase[]): TodoPhase | undefined {
	const activeTask = nextActionableTask(phases);
	if (!activeTask) return undefined;
	return phases.find((phase) => phase.tasks.includes(activeTask));
}

function formatOmittedTasks(count: number, direction: "earlier" | "later"): string {
	return `... (${count} ${direction} task${count === 1 ? "" : "s"})`;
}

function formatTask(todo: TodoItem): string {
	return `${getTodoMarker(todo.status)} ${sanitizeTodoText(todo.content)}`;
}

export function getTodoWidgetLines(phases: readonly TodoPhase[]): string[] | undefined {
	const activePhase = getActivePhase(phases);
	if (!activePhase) return undefined;
	const header = ["Todo", sanitizeTodoText(activePhase.name)];
	const taskLines = activePhase.tasks.map(formatTask);
	if (header.length + taskLines.length <= TODO_WIDGET_MAX_LINES) return [...header, ...taskLines];

	const activeTask = nextActionableTask([activePhase]);
	if (!activeTask) return undefined;
	const activeIndex = activePhase.tasks.indexOf(activeTask);
	const firstVisibleTask = Math.max(0, activeIndex - TODO_WIDGET_RECENT_TASKS);
	const earlierOmitted = firstVisibleTask;
	const bodyBudget = TODO_WIDGET_MAX_LINES - TODO_WIDGET_HEADER_LINES;
	const recentAndActive = taskLines.slice(firstVisibleTask, activeIndex + 1);
	const earlierMarkerRows = earlierOmitted > 0 ? 1 : 0;
	const pendingAfterActive = activePhase.tasks.slice(activeIndex + 1).filter((todo) => todo.status === "pending");
	const upcomingBudget = bodyBudget - recentAndActive.length - earlierMarkerRows;
	const visibleUpcomingCount =
		pendingAfterActive.length > upcomingBudget ? Math.max(0, upcomingBudget - 1) : pendingAfterActive.length;
	const laterOmitted = pendingAfterActive.length - visibleUpcomingCount;

	return [
		"Todo",
		sanitizeTodoText(activePhase.name),
		...(earlierOmitted > 0 ? [formatOmittedTasks(earlierOmitted, "earlier")] : []),
		...recentAndActive,
		...pendingAfterActive.slice(0, visibleUpcomingCount).map(formatTask),
		...(laterOmitted > 0 ? [formatOmittedTasks(laterOmitted, "later")] : []),
	];
}
