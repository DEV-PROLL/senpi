// Ported and adapted from oh-my-pi's todo tool (MIT License).
// Copyright (c) 2025 Mario Zechner
// Copyright (c) 2025-2026 Can Bölük
// https://github.com/can1357/oh-my-pi

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export type TodoOperation = "init" | "start" | "done" | "rm" | "drop" | "append" | "view";

export type TodoItem = {
	content: string;
	status: TodoStatus;
};

export type TodoPhase = {
	name: string;
	tasks: TodoItem[];
};

export type TodoCompletionTransition = {
	phase: string;
	content: string;
};

export type TodoToolDetails = {
	op?: TodoOperation;
	phases: TodoPhase[];
	storage: "session" | "memory";
	corrections?: string[];
	completedTasks?: TodoCompletionTransition[];
};

export type TodoStateEntry = {
	schema: "v2";
	phases: TodoPhase[];
};

export const TODO_STATE_ENTRY_TYPE = "senpi.todo-state";
export const DEFAULT_INIT_PHASE = "Tasks";

type TodoPhaseInput = {
	phase: string;
	items: string[];
};

export type TodoOpEntry = {
	op: TodoOperation;
	list?: TodoPhaseInput[];
	task?: string;
	phase?: string;
	items?: string[];
};
