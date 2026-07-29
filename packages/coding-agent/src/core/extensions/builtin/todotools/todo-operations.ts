// Ported and adapted from oh-my-pi's todo tool (MIT License).
// Copyright (c) 2025 Mario Zechner
// Copyright (c) 2025-2026 Can Bölük
// https://github.com/can1357/oh-my-pi

import { findPhaseByName, findTaskByContent, nextActionableTask, normalizeInProgressTask } from "./todo-query.ts";
import { getTaskTargets, resolvePhaseOrError, resolveTaskOrError } from "./todo-resolution.ts";
import { clonePhases } from "./todo-storage.ts";
import { DEFAULT_INIT_PHASE, type TodoOpEntry, type TodoPhase } from "./todo-types.ts";

export function initPhases(entry: TodoOpEntry, errors: string[], corrections?: string[]): TodoPhase[] {
	const list =
		entry.list ??
		(entry.items && entry.items.length > 0
			? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
			: undefined);
	if (!list) {
		errors.push("Missing list for init operation");
		return [];
	}

	const phases: TodoPhase[] = [];
	const phasesByName = new Map<string, TodoPhase>();
	const seenTasks = new Set<string>();
	for (const listEntry of list) {
		if (listEntry.items.length === 0) errors.push(`Phase "${listEntry.phase}" has no tasks in init list`);
		let phase = phasesByName.get(listEntry.phase);
		if (phase) {
			corrections?.push(`[auto-corrected] merged duplicate phase "${listEntry.phase}" in init list`);
		} else {
			phase = { name: listEntry.phase, tasks: [] };
			phasesByName.set(listEntry.phase, phase);
			phases.push(phase);
		}
		for (const content of listEntry.items) {
			if (seenTasks.has(content)) {
				corrections?.push(`[auto-corrected] kept first duplicate task "${content}" in init list`);
				continue;
			}
			seenTasks.add(content);
			phase.tasks.push({ content, status: "pending" });
		}
	}

	return phases;
}

export function appendItems(
	phases: TodoPhase[],
	entry: TodoOpEntry,
	errors: string[],
	corrections?: string[],
): TodoPhase[] {
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}

	const seen = new Set<string>();
	let hasDuplicate = false;
	for (const content of entry.items) {
		if (seen.has(content) || findTaskByContent(phases, content)) {
			errors.push(`Task "${content}" already exists`);
			hasDuplicate = true;
		}
		seen.add(content);
	}
	if (hasDuplicate) return phases;

	let phaseName = entry.phase;
	if (!phaseName) {
		const activeTask = nextActionableTask(phases);
		const activePhase = activeTask ? phases.find((phase) => phase.tasks.includes(activeTask)) : undefined;
		phaseName = activePhase?.name ?? phases[phases.length - 1]?.name ?? DEFAULT_INIT_PHASE;
		corrections?.push(`[auto-corrected] append had no phase; used "${phaseName}"`);
	}

	let phase = findPhaseByName(phases, phaseName);
	if (!phase) {
		phase = { name: phaseName, tasks: [] };
		phases.push(phase);
	}

	for (const content of entry.items) phase.tasks.push({ content, status: "pending" });
	return phases;
}

export function removeTasks(
	phases: TodoPhase[],
	entry: TodoOpEntry,
	errors: string[],
	corrections?: string[],
): TodoPhase[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors, corrections);
		if (!hit) return phases;
		hit.phase.tasks = hit.phase.tasks.filter((candidate) => candidate !== hit.task);
		return phases;
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors, corrections);
		if (!phase) return phases;
		phase.tasks = [];
		return phases;
	}
	for (const phase of phases) phase.tasks = [];
	return phases;
}

export function applyEntry(
	phases: TodoPhase[],
	entry: TodoOpEntry,
	errors: string[],
	corrections?: string[],
): TodoPhase[] {
	switch (entry.op) {
		case "init":
			return initPhases(entry, errors, corrections);
		case "start": {
			const hit = resolveTaskOrError(phases, entry.task, errors, corrections);
			if (!hit) return phases;
			for (const phase of phases) {
				for (const candidate of phase.tasks) {
					if (candidate.status === "in_progress" && candidate !== hit.task) candidate.status = "pending";
				}
			}
			hit.task.status = "in_progress";
			return phases;
		}
		case "done":
			for (const task of getTaskTargets(phases, entry, errors, corrections)) task.status = "completed";
			return phases;
		case "drop":
			for (const task of getTaskTargets(phases, entry, errors, corrections)) task.status = "abandoned";
			return phases;
		case "rm":
			return removeTasks(phases, entry, errors, corrections);
		case "append":
			return appendItems(phases, entry, errors, corrections);
		case "view":
			return phases;
	}
}

export function applyParams(
	phases: TodoPhase[],
	params: TodoOpEntry,
	corrections?: string[],
): { phases: TodoPhase[]; errors: string[] } {
	if (params.op === "view") return { phases, errors: [] };
	const original = clonePhases(phases);
	const errors: string[] = [];
	const next = applyEntry(phases, params, errors, corrections);
	if (errors.length > 0) return { phases: original, errors };
	normalizeInProgressTask(next);
	return { phases: next, errors };
}

export function applyOpsToPhases(
	currentPhases: readonly TodoPhase[],
	ops: readonly TodoOpEntry[],
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	let next = clonePhases(currentPhases);
	for (const op of ops) next = applyEntry(next, op, errors);
	if (errors.length > 0) return { phases: clonePhases(currentPhases), errors };
	normalizeInProgressTask(next);
	return { phases: next, errors };
}
