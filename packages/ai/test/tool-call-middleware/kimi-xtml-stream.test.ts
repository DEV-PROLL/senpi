import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createKimiXtmlStreamParser } from "../../src/tool-call-middleware/protocols/kimi-xtml/index.ts";
import type { StreamParserEvent } from "../../src/tool-call-middleware/types.ts";
import type { Tool } from "../../src/types.ts";

const weatherTool: Tool = {
	name: "get_weather",
	description: "Get weather for a city",
	parameters: Type.Object({
		city: Type.String(),
		count: Type.Optional(Type.Number()),
	}),
};

function seededRandom(seed: number): () => number {
	let current = seed;
	return () => {
		current = (current * 9301 + 49_297) % 233_280;
		return current / 233_280;
	};
}

function randomChunkSplit(text: string, minSize = 1, maxSize = 8, seed = 0): string[] {
	const random = seededRandom(seed);
	const chunks: string[] = [];
	let index = 0;
	while (index < text.length) {
		const size = Math.floor(random() * (maxSize - minSize + 1)) + minSize;
		chunks.push(text.slice(index, index + size));
		index += size;
	}
	return chunks;
}

function feedAll(chunks: string[]): StreamParserEvent[] {
	const parser = createKimiXtmlStreamParser([weatherTool]);
	const events: StreamParserEvent[] = [];
	for (const chunk of chunks) {
		events.push(...parser.feed(chunk));
	}
	events.push(...parser.finish());
	return events;
}

const FULL_BLOCK = [
	"<|open|>tools<|sep|>",
	'<|open|>call tool="get_weather" index="1"<|sep|>',
	'<|open|>argument key="city" type="string"<|sep|>Seoul<|close|>argument<|sep|>',
	'<|open|>argument key="count" type="number"<|sep|>3<|close|>argument<|sep|>',
	"<|close|>call<|sep|>",
	"<|close|>tools<|sep|>",
].join("");

describe("createKimiXtmlStreamParser", () => {
	it("emits start, argument deltas, and end for a single full feed", () => {
		// when
		const events = feedAll([FULL_BLOCK]);
		const kinds = events.map((event) => event.type);

		// then
		expect(kinds).toContain("toolcall_start");
		expect(kinds).toContain("toolcall_delta");
		expect(kinds).toContain("toolcall_end");
		const end = events.find((event) => event.type === "toolcall_end");
		expect(end).toMatchObject({
			index: 0,
			name: "get_weather",
			id: "kimi-xtml-tool-0",
			arguments: { city: "Seoul", count: 3 },
		});
	});

	it("passes narrative text through and never leaks XTML markers as text", () => {
		// when
		const events = feedAll([`Checking now. ${FULL_BLOCK} Done waiting.`]);
		const text = events
			.filter((event) => event.type === "text")
			.map((event) => (event.type === "text" ? event.text : ""))
			.join("");

		// then
		expect(text).toContain("Checking now.");
		expect(text).toContain("Done waiting.");
		expect(text).not.toContain("<|open|>");
		expect(text).not.toContain("<|close|>");
		expect(text).not.toContain("<|sep|>");
	});

	it("reassembles markers split across random chunk boundaries", () => {
		// given
		for (const seed of [1, 7, 42, 1337]) {
			const chunks = randomChunkSplit(FULL_BLOCK, 1, 8, seed);

			// when
			const events = feedAll(chunks);
			const end = events.find((event) => event.type === "toolcall_end");
			const text = events
				.filter((event) => event.type === "text")
				.map((event) => (event.type === "text" ? event.text : ""))
				.join("");

			// then
			expect(end, `seed ${seed}`).toMatchObject({
				name: "get_weather",
				arguments: { city: "Seoul", count: 3 },
			});
			expect(text, `seed ${seed}`).not.toContain("<|");
		}
	});

	it("handles a marker split exactly mid-token", () => {
		// when
		const events = feedAll(["<|op", "en|>tools<|se", "p|>", '<|open|>call tool="get_weather" index="1"<|sep|>', '<|open|>argument key="city" type="string"<|sep|>Seoul<|close|>argument<|sep|>', "<|close|>call<|sep|>", "<|close|>tools<|sep|>"]);
		const end = events.find((event) => event.type === "toolcall_end");

		// then
		expect(end).toMatchObject({ name: "get_weather", arguments: { city: "Seoul" } });
	});

	it("finalizes an unterminated call as incomplete with the arguments parsed so far", () => {
		// given: call never closes, stream ends after one complete argument
		const partial = [
			"<|open|>tools<|sep|>",
			'<|open|>call tool="get_weather" index="1"<|sep|>',
			'<|open|>argument key="city" type="string"<|sep|>Seoul<|close|>argument<|sep|>',
		].join("");

		// when
		const events = feedAll([partial]);
		const end = events.find((event) => event.type === "toolcall_end");

		// then
		expect(end).toMatchObject({
			name: "get_weather",
			arguments: { city: "Seoul" },
			incomplete: true,
		});
	});

	it("recovers text flow after a closed tools block", () => {
		// when
		const events = feedAll([FULL_BLOCK, "after the call"]);
		const kinds = events.map((event) => event.type);
		const lastText = events.filter((event) => event.type === "text").at(-1);

		// then
		expect(kinds.at(-1)).toBe("text");
		expect(lastText).toMatchObject({ type: "text", text: "after the call" });
	});
});
