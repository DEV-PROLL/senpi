import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizeGlobalDefaultExtensionModulePath } from "../src/core/resource-loader.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { real: string; linked: string; modulePath: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-shim-")));
	roots.push(root);
	const real = join(root, "real", "dist", "core", "extensions", "builtin");
	mkdirSync(real, { recursive: true });
	const modulePath = join(real, "diff.js");
	writeFileSync(modulePath, "export default () => {};\n");
	const linked = join(root, "linked");
	symlinkSync(join(root, "real"), linked);
	return { real, linked, modulePath };
}

describe("global default extension shim stability", () => {
	describe("#given the same build reached through a symlink and its real path", () => {
		it("#then both resolve to one canonical module path", () => {
			const { linked, modulePath } = fixture();
			const viaLink = join(linked, "dist", "core", "extensions", "builtin", "diff.js");

			expect(canonicalizeGlobalDefaultExtensionModulePath(viaLink)).toBe(
				canonicalizeGlobalDefaultExtensionModulePath(modulePath),
			);
		});
	});

	describe("#given a path that does not exist", () => {
		it("#then it is returned unchanged instead of throwing", () => {
			const missing = join(tmpdir(), "senpi-shim-missing", "nope.js");
			expect(canonicalizeGlobalDefaultExtensionModulePath(missing)).toBe(missing);
		});
	});
});
