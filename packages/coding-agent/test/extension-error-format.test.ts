import { describe, expect, it } from "vitest";
import { formatExtensionErrorHeadline } from "../src/modes/interactive/extension-error-format.ts";

describe("formatExtensionErrorHeadline", () => {
	it("renders runtime-emitted errors without the extension framing", () => {
		expect(
			formatExtensionErrorHeadline({
				extensionPath: "<runtime>",
				event: "session_title_generation",
				error: "Overloaded (overloaded_error, request req_011CdRmGPa88udPD5fc8dt8U)",
			}),
		).toBe(
			"Runtime error (session_title_generation): Overloaded (overloaded_error, request req_011CdRmGPa88udPD5fc8dt8U)",
		);
	});

	it("renders runtime-emitted errors without an event name", () => {
		expect(formatExtensionErrorHeadline({ extensionPath: "<runtime>", error: "boom" })).toBe("Runtime error: boom");
	});

	it("strips terminal control sequences a provider can smuggle through the error body", () => {
		const hostile = [
			"Overloaded",
			"\u001b]52;c;Zm9v\u0007",
			"\u001b]0;pwned\u001b\\",
			"\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007",
			"\u001b[31mred\u001b[0m",
			"\u009b2Jclear",
			"tail\u0000\u0008\u007f",
		].join("");
		const headline = formatExtensionErrorHeadline({
			extensionPath: "<runtime>",
			event: "session_title_generation",
			error: hostile,
		});

		expect(headline).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
		expect(headline).toBe("Runtime error (session_title_generation): Overloadedlinkredcleartail");
	});

	it("strips control sequences smuggled through the event name and extension path", () => {
		expect(
			formatExtensionErrorHeadline({
				extensionPath: "/ext\u001b]52;c;Zm9v\u0007.ts",
				event: "tool\u001b[31m_call",
				error: "boom",
			}),
		).toBe('Extension "/ext.ts" error: boom');
	});

	it("keeps the extension framing for real extension paths", () => {
		expect(
			formatExtensionErrorHeadline({ extensionPath: "/home/user/ext.ts", event: "tool_call", error: "boom" }),
		).toBe('Extension "/home/user/ext.ts" error: boom');
	});
});
