import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchUrl } from "../../../src/core/extensions/builtin/webfetch/webfetch/fetcher.ts";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("undici", () => ({ request: requestMock }));

interface DumpOptions {
	readonly limit: number;
	readonly signal?: AbortSignal;
}

interface RedirectBody extends AsyncIterable<Uint8Array> {
	readonly destroy: (error?: Error) => void;
	readonly dump?: (options?: DumpOptions) => Promise<void>;
}

beforeEach(() => {
	requestMock.mockReset();
});

function queueRedirectResponses(redirectBody: RedirectBody): void {
	requestMock
		.mockResolvedValueOnce({
			statusCode: 302,
			statusText: "Found",
			headers: { location: "/final" },
			body: redirectBody,
		})
		.mockResolvedValueOnce({
			statusCode: 200,
			statusText: "OK",
			headers: { "content-type": "text/plain" },
			body: {
				destroy: vi.fn<(error?: Error) => void>(),
				async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
					yield new TextEncoder().encode("ok");
				},
			},
		});
}

describe("issue #1089 webfetch redirect body cleanup", () => {
	it("destroys without an error when the redirect body has no dump method", async () => {
		// Given
		const redirectDestroy = vi.fn<(error?: Error) => void>();
		queueRedirectResponses({
			destroy: redirectDestroy,
			async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
				yield new TextEncoder().encode("redirect body");
			},
		});

		// When
		const result = await fetchUrl({ url: "https://example.test/start", format: "text" });

		// Then
		expect(result.url).toBe("https://example.test/final");
		expect(redirectDestroy).toHaveBeenCalledExactlyOnceWith();
	});

	it("uses dump without destroying when the redirect body supports dump", async () => {
		// Given
		const dump = vi.fn<(options?: DumpOptions) => Promise<void>>().mockResolvedValue();
		const destroy = vi.fn<(error?: Error) => void>();
		queueRedirectResponses({
			dump,
			destroy,
			async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
				yield new TextEncoder().encode("redirect body");
			},
		});

		// When
		await fetchUrl({ url: "https://example.test/start", format: "text" });

		// Then
		expect(dump).toHaveBeenCalledExactlyOnceWith({ limit: 1024 });
		expect(destroy).not.toHaveBeenCalled();
	});

	it("destroys without the dump error when redirect body dumping fails", async () => {
		// Given
		const dump = vi.fn<(options?: DumpOptions) => Promise<void>>().mockRejectedValue(new Error("dump failed"));
		const destroy = vi.fn<(error?: Error) => void>();
		queueRedirectResponses({
			dump,
			destroy,
			async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
				yield new TextEncoder().encode("redirect body");
			},
		});

		// When
		await fetchUrl({ url: "https://example.test/start", format: "text" });

		// Then
		expect(destroy).toHaveBeenCalledExactlyOnceWith();
	});
});
