import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findProjectRoot } from "../../../src/core/extensions/builtin/rules/rules/project-root.ts";

const { cwdRoot, startPath } = vi.hoisted(() => ({
	cwdRoot: "E:\\",
	startPath: "C:\\workspace\\plain\\nested",
}));

vi.mock("node:fs", () => ({
	existsSync: (path: string) => path === startPath,
	statSync: () => ({ isDirectory: () => true }),
}));

vi.mock("node:path", async (importOriginal) => {
	const path = await importOriginal<typeof import("node:path")>();
	return {
		...path,
		dirname: path.win32.dirname,
		join: path.win32.join,
		resolve: (input: string) => (input === "/" ? cwdRoot : path.win32.resolve(input)),
	};
});

describe("rules findProjectRoot cross-drive termination", () => {
	it("#given startPath on a different drive than cwd (Windows cross-drive) #when finding root #then terminates with null instead of looping forever", () => {
		// given
		expect(win32.dirname("C:\\")).toBe("C:\\");

		// when
		const result = findProjectRoot(startPath, [".nonexistent-marker-senpi"]);

		// then
		expect(result).toBeNull();
	});
});
