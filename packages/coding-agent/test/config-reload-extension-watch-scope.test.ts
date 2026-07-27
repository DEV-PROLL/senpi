import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	isLoadableExtensionEntry,
	isScannableExtensionDirectory,
} from "../src/core/extensions/builtin/config-reload/extension-watch-scope.ts";

describe("config reload extension watch scope", () => {
	describe("#given a direct entry in the extensions directory", () => {
		it("#then treats extension sources as loadable", () => {
			expect(isLoadableExtensionEntry("diff.js")).toBe(true);
			expect(isLoadableExtensionEntry("tps.ts")).toBe(true);
		});

		it("#then ignores non-source files", () => {
			expect(isLoadableExtensionEntry("notes.md")).toBe(false);
			expect(isLoadableExtensionEntry("state.json")).toBe(false);
		});
	});

	describe("#given a subdirectory extension", () => {
		it("#then treats its discovery entry points as loadable", () => {
			expect(isLoadableExtensionEntry(join("my-ext", "index.ts"))).toBe(true);
			expect(isLoadableExtensionEntry(join("my-ext", "index.js"))).toBe(true);
			expect(isLoadableExtensionEntry(join("my-ext", "package.json"))).toBe(true);
		});

		it("#then ignores files the loader never discovers", () => {
			expect(isLoadableExtensionEntry(join("my-ext", "helper.ts"))).toBe(false);
			expect(isLoadableExtensionEntry(join("my-ext", "src", "index.ts"))).toBe(false);
		});
	});

	describe("#given extension runtime state written below the discovery depth", () => {
		it("#then never treats it as a loadable entry", () => {
			const goalState = join(
				"goal",
				"no-session",
				"2fca6eb7d09fc68d11abc56e",
				"019fa192-1633-7803-9770-f2c76bd91ca3.json",
			);
			expect(isLoadableExtensionEntry(goalState)).toBe(false);
			expect(isScannableExtensionDirectory(join("goal", "no-session"))).toBe(false);
		});
	});

	describe("#given directory descent during a scan", () => {
		it("#then descends into the root and immediate children only", () => {
			expect(isScannableExtensionDirectory("")).toBe(true);
			expect(isScannableExtensionDirectory("goal")).toBe(true);
			expect(isScannableExtensionDirectory(join("goal", "no-session"))).toBe(false);
		});
	});
});
