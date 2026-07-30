import { describe, expect, it } from "vitest";
import {
	getTodoWidgetLines,
	type TodoItem,
	type TodoPhase,
	type TodoStatus,
} from "../../src/core/extensions/builtin/todotools/state.ts";

function task(content: string, status: TodoStatus): TodoItem {
	return { content, status };
}

function phase(name: string, tasks: readonly TodoItem[]): TodoPhase {
	return { name, tasks: [...tasks] };
}

function pendingTasks(count: number): TodoItem[] {
	return Array.from({ length: count }, (_, index) => task(`Pending ${index + 1}`, "pending"));
}

describe("todo widget sliding window", () => {
	it("keeps the active task visible at the first and last positions", () => {
		const activeFirst = getTodoWidgetLines([phase("Review", [task("Active", "in_progress"), ...pendingTasks(9)])]);
		const activeLast = getTodoWidgetLines([
			phase("Review", [
				...Array.from({ length: 9 }, (_, index) => task(`Completed ${index + 1}`, "completed")),
				task("Active", "in_progress"),
			]),
		]);

		expect(activeFirst).toEqual([
			"Todo",
			"Review",
			"[•] Active",
			"[ ] Pending 1",
			"[ ] Pending 2",
			"[ ] Pending 3",
			"[ ] Pending 4",
			"[ ] Pending 5",
			"[ ] Pending 6",
			"... (3 later tasks)",
		]);
		expect(activeLast).toEqual([
			"Todo",
			"Review",
			"... (7 earlier tasks)",
			"[✓] Completed 8",
			"[✓] Completed 9",
			"[•] Active",
		]);
	});

	it("preserves an exact eight-row body and hides all-completed phases", () => {
		const exactBody = getTodoWidgetLines([
			phase("Exact", [
				task("Completed 1", "completed"),
				task("Completed 2", "completed"),
				task("Completed 3", "completed"),
				task("Active", "in_progress"),
				...pendingTasks(4),
			]),
		]);

		expect(exactBody).toEqual([
			"Todo",
			"Exact",
			"[✓] Completed 1",
			"[✓] Completed 2",
			"[✓] Completed 3",
			"[•] Active",
			"[ ] Pending 1",
			"[ ] Pending 2",
			"[ ] Pending 3",
			"[ ] Pending 4",
		]);
		expect(exactBody).toHaveLength(10);
		expect(getTodoWidgetLines([phase("Done", [task("Closed", "completed")])])).toBeUndefined();
	});

	it("uses only pending tasks for the forward window and later count", () => {
		const lines = getTodoWidgetLines([
			phase("Review", [
				task("Completed before", "completed"),
				task("Active", "in_progress"),
				task("Completed ahead", "completed"),
				task("Dropped ahead", "abandoned"),
				...pendingTasks(7),
			]),
		]);

		expect(lines).toEqual([
			"Todo",
			"Review",
			"[✓] Completed before",
			"[•] Active",
			"[ ] Pending 1",
			"[ ] Pending 2",
			"[ ] Pending 3",
			"[ ] Pending 4",
			"[ ] Pending 5",
			"... (2 later tasks)",
		]);
	});

	it("does not report terminal tasks after an active task as later work", () => {
		const lines = getTodoWidgetLines([
			phase("Review", [
				...Array.from({ length: 5 }, (_, index) => task(`Completed ${index + 1}`, "completed")),
				task("Active", "in_progress"),
				task("Completed ahead", "completed"),
				task("Dropped ahead", "abandoned"),
				task("Completed last", "completed"),
			]),
		]);

		expect(lines).toEqual([
			"Todo",
			"Review",
			"... (3 earlier tasks)",
			"[✓] Completed 4",
			"[✓] Completed 5",
			"[•] Active",
		]);
	});

	it("reports a singular earlier omission count", () => {
		const lines = getTodoWidgetLines([
			phase("Review", [
				task("Completed 1", "completed"),
				task("Completed 2", "completed"),
				task("Completed 3", "completed"),
				task("Active", "in_progress"),
				...pendingTasks(6),
			]),
		]);

		expect(lines).toEqual([
			"Todo",
			"Review",
			"... (1 earlier task)",
			"[✓] Completed 2",
			"[✓] Completed 3",
			"[•] Active",
			"[ ] Pending 1",
			"[ ] Pending 2",
			"[ ] Pending 3",
			"... (3 later tasks)",
		]);
	});

	it("windows only the active phase with interleaved terminal tasks", () => {
		const lines = getTodoWidgetLines([
			phase("Closed", [task("Old", "completed")]),
			phase("Active phase", [
				task("Dropped before", "abandoned"),
				task("Active", "in_progress"),
				task("Completed ahead", "completed"),
				task("Dropped ahead", "abandoned"),
				...pendingTasks(6),
			]),
			phase("Later", [task("Future", "pending")]),
		]);

		expect(lines).toEqual([
			"Todo",
			"Active phase",
			"[×] Dropped before",
			"[•] Active",
			"[ ] Pending 1",
			"[ ] Pending 2",
			"[ ] Pending 3",
			"[ ] Pending 4",
			"[ ] Pending 5",
			"[ ] Pending 6",
		]);
	});

	it("preserves the line budget and omission totals across active positions", () => {
		let caseCount = 0;
		for (let taskCount = 1; taskCount <= 30; taskCount += 1) {
			for (let activeIndex = 0; activeIndex < taskCount; activeIndex += 1) {
				const tasks = Array.from({ length: taskCount }, (_, index) =>
					task(
						`Task ${index + 1}`,
						index < activeIndex ? "completed" : index === activeIndex ? "in_progress" : "pending",
					),
				);

				const lines = getTodoWidgetLines([phase("Matrix", tasks)]);
				expect(lines).toBeDefined();
				if (!lines) continue;
				expect(lines.length).toBeLessThanOrEqual(10);
				expect(lines).toContain(`[•] Task ${activeIndex + 1}`);

				const visibleTasks = lines.slice(2).filter((line) => line.startsWith("[")).length;
				const omittedTasks = lines
					.slice(2)
					.filter((line) => line.startsWith("..."))
					.reduce((total, line) => {
						const match = line.match(/\d+/);
						return total + (match ? Number(match[0]) : 0);
					}, 0);
				expect(visibleTasks + omittedTasks).toBe(taskCount);
				caseCount += 1;
			}
		}

		expect(caseCount).toBe(465);
	});
});
