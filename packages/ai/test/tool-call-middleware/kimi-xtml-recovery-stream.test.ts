import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createXtmlRecoveryStreamParser } from "../../src/tool-call-middleware/protocols/kimi-xtml/recovery-stream.ts";
import type { StreamParserEvent } from "../../src/tool-call-middleware/types.ts";
import type { Tool } from "../../src/types.ts";

const weatherTool: Tool = {
	name: "get_weather",
	description: "Get weather for a city",
	parameters: Type.Object({ city: Type.String() }),
};

function textOf(events: readonly StreamParserEvent[]): string {
	return events
		.filter((event) => event.type === "text")
		.map((event) => (event.type === "text" ? event.text : ""))
		.join("");
}

const LEAKED_BLOCK = [
	"<|open|>tools<|sep|>",
	'<|open|>call tool="get_weather" index="1"<|sep|>',
	'<|open|>argument key="city" type="string"<|sep|>Seoul<|close|>argument<|sep|>',
	"<|close|>call<|sep|>",
	"<|close|>tools<|sep|>",
].join("");

describe("createXtmlRecoveryStreamParser", () => {
	it("recovers a leaked XTML tools block into tool call events", () => {
		// given
		const parser = createXtmlRecoveryStreamParser([weatherTool]);

		// when
		const events = [...parser.feed(`One moment. ${LEAKED_BLOCK} Done.`), ...parser.finish()];

		// then
		const end = events.find((event) => event.type === "toolcall_end");
		expect(end).toMatchObject({ name: "get_weather", arguments: { city: "Seoul" } });
		expect(events.find((event) => event.type === "toolcall_start")).toMatchObject({ name: "get_weather" });
		const text = textOf(events);
		expect(text).toContain("One moment.");
		expect(text).toContain("Done.");
		expect(text).not.toContain("<|");
	});

	it("strips leaked channel-transition markers from visible text", () => {
		// given
		const parser = createXtmlRecoveryStreamParser([weatherTool]);

		// when
		const events = [
			...parser.feed("reasoning about the weather<|close|>think<|sep|><|open|>response<|sep|>The answer is 31C."),
			...parser.finish(),
		];

		// then
		expect(textOf(events)).toBe("reasoning about the weatherThe answer is 31C.");
	});

	it("strips a leaked message-close marker sequence", () => {
		// given
		const parser = createXtmlRecoveryStreamParser([weatherTool]);

		// when
		const events = [
			...parser.feed("final answer<|close|>response<|sep|><|close|>message<|sep|>"),
			...parser.finish(),
		];

		// then
		expect(textOf(events)).toBe("final answer");
	});

	it("strips an unnamed close marker across every chunk split", () => {
		// given
		const marker = "<|close|><|sep|>";
		const outputs: string[] = [];

		// when
		for (let split = 1; split < marker.length; split += 1) {
			const parser = createXtmlRecoveryStreamParser([weatherTool]);
			const events = [
				...parser.feed(`before${marker.slice(0, split)}`),
				...parser.feed(`${marker.slice(split)}after`),
				...parser.finish(),
			];
			outputs.push(textOf(events));
		}

		// then
		expect(outputs).toEqual(Array.from({ length: marker.length - 1 }, () => "beforeafter"));
	});

	it("reassembles markers split across chunks", () => {
		// given
		const parser = createXtmlRecoveryStreamParser([weatherTool]);
		const chunks = ["One moment. <|op", "en|>tools<|se", "p|>", LEAKED_BLOCK.slice(XTML_TOOLS_OPEN_LENGTH), " Done."];

		// when
		const events: StreamParserEvent[] = [];
		for (const chunk of chunks) events.push(...parser.feed(chunk));
		events.push(...parser.finish());

		// then
		expect(events.find((event) => event.type === "toolcall_end")).toMatchObject({
			name: "get_weather",
			arguments: { city: "Seoul" },
		});
		expect(textOf(events)).not.toContain("<|");
	});

	it("restores a dangling partial marker as plain text on interrupt", () => {
		// given
		const parser = createXtmlRecoveryStreamParser([weatherTool]);

		// when
		const events = [...parser.feed("hello<|op"), ...parser.interrupt()];

		// then
		expect(textOf(events)).toBe("hello<|op");
	});

	it("passes ordinary text without markers through untouched", () => {
		// given
		const parser = createXtmlRecoveryStreamParser([weatherTool]);

		// when
		const events = [...parser.feed("plain answer with <xml> and |pipes|"), ...parser.finish()];

		// then
		expect(textOf(events)).toBe("plain answer with <xml> and |pipes|");
		expect(events.some((event) => event.type === "toolcall_start")).toBe(false);
	});
});

const XTML_TOOLS_OPEN_LENGTH = "<|open|>tools<|sep|>".length;
