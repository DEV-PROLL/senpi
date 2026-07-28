import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { describe, expect, it } from "vitest";
import { findProjectRoot } from "../../../src/core/extensions/builtin/rules/rules/project-root.ts";

describe("rules findProjectRoot cross-drive termination", () => {
	it("#given startPath on a different drive than cwd (Windows cross-drive) #when finding root #then terminates with null instead of looping forever", () => {
		// Cross-drive paths only exist on Windows; this scenario cannot occur elsewhere.
		if (process.platform !== "win32") {
			return;
		}
		// The bug needs the temp dir and cwd on different drive roots; skip the body on single-drive machines.
		if (parse(tmpdir()).root.toLowerCase() === parse(process.cwd()).root.toLowerCase()) {
			return;
		}
		// given
		const root = mkdtempSync(join(tmpdir(), "senpi-rules-project-root-"));
		const startPath = join(root, "plain", "nested");
		mkdirSync(startPath, { recursive: true });

		try {
			// when
			const result = findProjectRoot(startPath, [".nonexistent-marker-senpi"]);

			// then
			expect(result).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
