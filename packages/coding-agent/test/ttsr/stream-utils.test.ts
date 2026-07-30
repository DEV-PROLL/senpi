import { describe, expect, it } from "vitest";

import { FixedRing, isAsciiWhitespace, ScalarScanner } from "../../src/core/extensions/builtin/ttsr/stream-utils.ts";

describe("ScalarScanner", () => {
	it("iterates ASCII scalars with cumulative UTF-16 offsets", () => {
		const scanner = new ScalarScanner();
		const entries = scanner.push("abc");
		expect(entries.map((e) => e.value)).toEqual(["a", "b", "c"]);
		expect(entries.map((e) => e.startOffset)).toEqual([0, 1, 2]);
		expect(entries.map((e) => e.width)).toEqual([1, 1, 1]);
	});

	it("joins a surrogate pair split across two deltas", () => {
		const scanner = new ScalarScanner();
		const emoji = "😀";
		const high = emoji.slice(0, 1);
		const low = emoji.slice(1);
		const first = scanner.push(`x${high}`);
		expect(first.map((e) => e.value)).toEqual(["x"]);
		expect(first[0]?.width).toBe(1);
		const second = scanner.push(`${low}y`);
		expect(second.map((e) => e.value)).toEqual([emoji, "y"]);
		expect(second[0]?.startOffset).toBe(1);
		expect(second[0]?.width).toBe(2);
		expect(second[1]?.startOffset).toBe(3);
	});

	it("handles a delta that is only a high surrogate then only a low surrogate", () => {
		const scanner = new ScalarScanner();
		const emoji = "🌊";
		expect(scanner.push(emoji.slice(0, 1))).toEqual([]);
		const out = scanner.push(emoji.slice(1));
		expect(out).toHaveLength(1);
		expect(out[0]?.value).toBe(emoji);
		expect(out[0]?.startOffset).toBe(0);
		expect(out[0]?.width).toBe(2);
	});

	it("tracks offsets across CJK scalars", () => {
		const scanner = new ScalarScanner();
		const entries = scanner.push("界a界");
		expect(entries.map((e) => e.startOffset)).toEqual([0, 1, 2]);
		expect(entries.every((e) => e.width === 1)).toBe(true);
	});

	it("flush emits nothing when no surrogate is pending and reports pending state", () => {
		const scanner = new ScalarScanner();
		scanner.push("😀".slice(0, 1));
		expect(scanner.hasPendingSurrogate()).toBe(true);
		scanner.push("😀".slice(1));
		expect(scanner.hasPendingSurrogate()).toBe(false);
	});
});

describe("FixedRing", () => {
	it("keeps the most recent N entries in insertion order", () => {
		const ring = new FixedRing<number>(3);
		for (const n of [1, 2, 3, 4, 5]) ring.push(n);
		expect(ring.toArray()).toEqual([3, 4, 5]);
		expect(ring.size).toBe(3);
	});

	it("getBack(0) is the newest, getBack(n) walks backwards", () => {
		const ring = new FixedRing<string>(4);
		for (const s of ["a", "b", "c"]) ring.push(s);
		expect(ring.getBack(0)).toBe("c");
		expect(ring.getBack(1)).toBe("b");
		expect(ring.getBack(2)).toBe("a");
		expect(ring.getBack(3)).toBeUndefined();
	});

	it("preserves entry payloads after eviction of older entries", () => {
		const ring = new FixedRing<{ v: number; off: number }>(2);
		ring.push({ v: 1, off: 10 });
		ring.push({ v: 2, off: 20 });
		ring.push({ v: 3, off: 30 });
		expect(ring.getBack(0)).toEqual({ v: 3, off: 30 });
		expect(ring.getBack(1)).toEqual({ v: 2, off: 20 });
	});
});

describe("isAsciiWhitespace", () => {
	it("accepts space, tab, newline, carriage return, form feed, vertical tab", () => {
		for (const ch of [" ", "\t", "\n", "\r", "\f", "\v"]) {
			expect(isAsciiWhitespace(ch.charCodeAt(0))).toBe(true);
		}
	});

	it("rejects non-whitespace and non-ASCII whitespace", () => {
		for (const ch of ["a", "0", "!", " ", "　"]) {
			expect(isAsciiWhitespace(ch.charCodeAt(0))).toBe(false);
		}
	});
});
