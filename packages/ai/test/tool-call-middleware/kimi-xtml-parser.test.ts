import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { parseKimiXtmlGeneratedText } from "../../src/tool-call-middleware/protocols/kimi-xtml/index.ts";
import type { Tool } from "../../src/types.ts";

const weatherTool: Tool = {
	name: "get_weather",
	description: "Get weather for a city",
	parameters: Type.Object({
		city: Type.String(),
		count: Type.Optional(Type.Number()),
		flag: Type.Optional(Type.Boolean()),
	}),
};

const catalogTool: Tool = {
	name: "search_catalog",
	description: "Search a nested catalog",
	parameters: Type.Object({
		filters: Type.Object({ category: Type.String() }),
		tags: Type.Array(Type.String()),
	}),
};

describe("parseKimiXtmlGeneratedText", () => {
	it("parses a full XTML tools block with typed arguments", () => {
		// given
		const text = [
			"<|open|>tools<|sep|>",
			'<|open|>call tool="get_weather" index="1"<|sep|>',
			'<|open|>argument key="city" type="string"<|sep|>Seoul<|close|>argument<|sep|>',
			'<|open|>argument key="count" type="number"<|sep|>3<|close|>argument<|sep|>',
			'<|open|>argument key="flag" type="boolean"<|sep|>true<|close|>argument<|sep|>',
			"<|close|>call<|sep|>",
			"<|close|>tools<|sep|>",
		].join("");

		// when
		const result = parseKimiXtmlGeneratedText(text, [weatherTool]);

		// then
		expect(result).toEqual([
			{
				name: "get_weather",
				arguments: { city: "Seoul", count: 3, flag: true },
			},
		]);
	});

	it("parses object and array arguments from strict JSON values", () => {
		// given
		const text = [
			"<|open|>tools<|sep|>",
			'<|open|>call tool="search_catalog" index="1"<|sep|>',
			'<|open|>argument key="filters" type="object"<|sep|>{"category":"books"}<|close|>argument<|sep|>',
			'<|open|>argument key="tags" type="array"<|sep|>["fiction","award"]<|close|>argument<|sep|>',
			"<|close|>call<|sep|>",
			"<|close|>tools<|sep|>",
		].join("");

		// when
		const result = parseKimiXtmlGeneratedText(text, [catalogTool]);

		// then
		expect(result).toEqual([
			{
				name: "search_catalog",
				arguments: { filters: { category: "books" }, tags: ["fiction", "award"] },
			},
		]);
	});

	it("parses multiple calls inside one tools block", () => {
		// given
		const text = [
			"<|open|>tools<|sep|>",
			'<|open|>call tool="get_weather" index="1"<|sep|>',
			'<|open|>argument key="city" type="string"<|sep|>Seoul<|close|>argument<|sep|>',
			"<|close|>call<|sep|>",
			'<|open|>call tool="get_weather" index="2"<|sep|>',
			'<|open|>argument key="city" type="string"<|sep|>Busan<|close|>argument<|sep|>',
			"<|close|>call<|sep|>",
			"<|close|>tools<|sep|>",
		].join("");

		// when
		const result = parseKimiXtmlGeneratedText(text, [weatherTool]);

		// then
		expect(result).toEqual([
			{ name: "get_weather", arguments: { city: "Seoul" } },
			{ name: "get_weather", arguments: { city: "Busan" } },
		]);
	});

	it("accepts single-quoted and unquoted header attributes", () => {
		// given
		const text = [
			"<|open|>tools<|sep|>",
			"<|open|>call tool='get_weather' index='1'<|sep|>",
			"<|open|>argument key=city type=string<|sep|>Seoul<|close|>argument<|sep|>",
			"<|close|>call<|sep|>",
			"<|close|>tools<|sep|>",
		].join("");

		// when
		const result = parseKimiXtmlGeneratedText(text, [weatherTool]);

		// then
		expect(result).toEqual([{ name: "get_weather", arguments: { city: "Seoul" } }]);
	});

	it("ignores narrative text outside tools blocks", () => {
		// given
		const text = [
			"Let me check that for you.",
			"<|open|>tools<|sep|>",
			'<|open|>call tool="get_weather" index="1"<|sep|>',
			'<|open|>argument key="city" type="string"<|sep|>Seoul<|close|>argument<|sep|>',
			"<|close|>call<|sep|>",
			"<|close|>tools<|sep|>",
			"One moment.",
		].join("\n");

		// when
		const result = parseKimiXtmlGeneratedText(text, [weatherTool]);

		// then
		expect(result).toEqual([{ name: "get_weather", arguments: { city: "Seoul" } }]);
	});

	it("treats a missing type attribute as a raw string", () => {
		// given
		const text = [
			"<|open|>tools<|sep|>",
			'<|open|>call tool="get_weather" index="1"<|sep|>',
			'<|open|>argument key="city"<|sep|>Seoul<|close|>argument<|sep|>',
			"<|close|>call<|sep|>",
			"<|close|>tools<|sep|>",
		].join("");

		// when
		const result = parseKimiXtmlGeneratedText(text, [weatherTool]);

		// then
		expect(result).toEqual([{ name: "get_weather", arguments: { city: "Seoul" } }]);
	});

	it("treats an unknown type attribute as a raw string", () => {
		// given
		const text = [
			"<|open|>tools<|sep|>",
			'<|open|>call tool="get_weather" index="1"<|sep|>',
			'<|open|>argument key="city" type="mystery"<|sep|>Seoul<|close|>argument<|sep|>',
			"<|close|>call<|sep|>",
			"<|close|>tools<|sep|>",
		].join("");

		// when
		const result = parseKimiXtmlGeneratedText(text, [weatherTool]);

		// then
		expect(result).toEqual([{ name: "get_weather", arguments: { city: "Seoul" } }]);
	});

	it("skips a call for an unknown tool and reports the error", () => {
		// given
		const onError = vi.fn();
		const text = [
			"<|open|>tools<|sep|>",
			'<|open|>call tool="get_traffic" index="1"<|sep|>',
			'<|open|>argument key="city" type="string"<|sep|>Seoul<|close|>argument<|sep|>',
			"<|close|>call<|sep|>",
			"<|close|>tools<|sep|>",
		].join("");

		// when
		const result = parseKimiXtmlGeneratedText(text, [weatherTool], { onError });

		// then
		expect(result).toEqual([]);
		expect(onError).toHaveBeenCalledOnce();
	});

	it("rejects malformed JSON in an object argument and reports the error", () => {
		// given
		const onError = vi.fn();
		const text = [
			"<|open|>tools<|sep|>",
			'<|open|>call tool="search_catalog" index="1"<|sep|>',
			'<|open|>argument key="filters" type="object"<|sep|>{category:books}<|close|>argument<|sep|>',
			"<|close|>call<|sep|>",
			"<|close|>tools<|sep|>",
		].join("");

		// when
		const result = parseKimiXtmlGeneratedText(text, [catalogTool], { onError });

		// then
		expect(result).toEqual([]);
		expect(onError).toHaveBeenCalledOnce();
	});

	it("parses a complete call even when the closing tools marker is missing", () => {
		// given
		const text = [
			"<|open|>tools<|sep|>",
			'<|open|>call tool="get_weather" index="1"<|sep|>',
			'<|open|>argument key="city" type="string"<|sep|>Seoul<|close|>argument<|sep|>',
			"<|close|>call<|sep|>",
		].join("");

		// when
		const result = parseKimiXtmlGeneratedText(text, [weatherTool]);

		// then
		expect(result).toEqual([{ name: "get_weather", arguments: { city: "Seoul" } }]);
	});
});
