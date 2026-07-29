import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	kimiXtmlFormatToolCall,
	kimiXtmlFormatToolResponse,
	kimiXtmlFormatToolsSystemPrompt,
	parseKimiXtmlGeneratedText,
} from "../../src/tool-call-middleware/protocols/kimi-xtml/index.ts";
import type { Tool } from "../../src/types.ts";

const weatherTool: Tool = {
	name: "get_weather",
	description: "Get weather for a city",
	parameters: Type.Object({ city: Type.String() }),
};

describe("kimiXtmlFormatToolCall", () => {
	it("renders a call in the K3 XTML channel syntax", () => {
		// when
		const rendered = kimiXtmlFormatToolCall("get_weather", { city: "Seoul", count: 3 });

		// then
		expect(rendered).toBe(
			"<|open|>tools<|sep|>" +
				'<|open|>call tool="get_weather" index="1"<|sep|>' +
				'<|open|>argument key="city" type="string"<|sep|>Seoul<|close|>argument<|sep|>' +
				'<|open|>argument key="count" type="number"<|sep|>3<|close|>argument<|sep|>' +
				"<|close|>call<|sep|>" +
				"<|close|>tools<|sep|>",
		);
	});

	it("serializes object and array arguments as JSON", () => {
		// when
		const rendered = kimiXtmlFormatToolCall("search", { filters: { a: 1 }, tags: ["x", "y"] });

		// then
		expect(rendered).toContain('<|open|>argument key="filters" type="object"<|sep|>{"a":1}<|close|>argument<|sep|>');
		expect(rendered).toContain('<|open|>argument key="tags" type="array"<|sep|>["x","y"]<|close|>argument<|sep|>');
	});

	it("round-trips through the parser", () => {
		// given
		const args = { city: "Seoul", count: 3, flag: true, filters: { a: 1 }, tags: ["x"] };

		// when
		const parsed = parseKimiXtmlGeneratedText(kimiXtmlFormatToolCall("get_weather", args), [weatherTool]);

		// then
		expect(parsed).toEqual([{ name: "get_weather", arguments: args }]);
	});
});

describe("kimiXtmlFormatToolResponse", () => {
	it("renders results with the Kimi-family return convention", () => {
		// when
		const rendered = kimiXtmlFormatToolResponse("get_weather", "kimi-xtml-tool-0", [{ type: "text", text: "sunny, 31C" }]);

		// then
		expect(rendered).toBe("## Return of get_weather\nsunny, 31C");
	});
});

describe("kimiXtmlFormatToolsSystemPrompt", () => {
	it("teaches the exact XTML emission syntax with the tool schemas", () => {
		// when
		const prompt = kimiXtmlFormatToolsSystemPrompt([weatherTool]);

		// then
		expect(prompt).toContain("get_weather");
		expect(prompt).toContain("<|open|>tools<|sep|>");
		expect(prompt).toContain('<|open|>call tool="');
		expect(prompt).toContain('<|open|>argument key="');
		expect(prompt).toContain("<|close|>call<|sep|>");
		expect(prompt).toContain("<|close|>tools<|sep|>");
	});
});
