import { describe, expect, it, vi } from "vitest";

/**
 * Regression: clipboard paste failures must never be silently swallowed.
 *
 * Field report (Discord 2026-07-30): the CLI appeared to freeze/misbehave
 * around clipboard image handling with zero trace. handleClipboardPaste's
 * catch block dropped every error, so permission failures, native-clipboard
 * errors, and tmp-file write failures were indistinguishable from "nothing
 * on the clipboard".
 */

const clipboardImageMock = vi.hoisted(() => ({
	readClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
}));

const clipboardTextMock = vi.hoisted(() => ({
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard-image.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/utils/clipboard-image.ts")>();
	return { ...original, readClipboardImage: clipboardImageMock.readClipboardImage };
});

vi.mock("../src/utils/clipboard.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/utils/clipboard.ts")>();
	return { ...original, readClipboardText: clipboardTextMock.readClipboardText };
});

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type HandleClipboardPaste = (this: object) => Promise<void>;

function getHandleClipboardPaste(): HandleClipboardPaste {
	const handler = Reflect.get(InteractiveMode.prototype, "handleClipboardPaste");
	if (typeof handler !== "function") throw new Error("Expected InteractiveMode.handleClipboardPaste");
	return handler as HandleClipboardPaste;
}

function makeContext() {
	const sessionLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
	return {
		editor: { insertTextAtCursor: vi.fn() },
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		sessionLogger,
		getSessionLogger: () => sessionLogger,
	};
}

describe("InteractiveMode clipboard paste error surfacing", () => {
	it("surfaces a status message when clipboard image read fails", async () => {
		clipboardImageMock.readClipboardImage.mockRejectedValueOnce(new Error("pasteboard permission denied"));
		clipboardTextMock.readClipboardText.mockResolvedValue(null);
		const context = makeContext();

		await getHandleClipboardPaste().call(context);

		expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledTimes(1);
		const status = context.showStatus.mock.calls[0]?.[0];
		expect(String(status)).toContain("Clipboard paste failed");
		expect(String(status)).toContain("pasteboard permission denied");
		expect(context.sessionLogger.warn).toHaveBeenCalledWith(
			"clipboard_error",
			expect.objectContaining({ op: "paste", error: expect.stringContaining("pasteboard permission denied") }),
		);
	});

	it("surfaces a status message when clipboard text read fails after empty image", async () => {
		clipboardImageMock.readClipboardImage.mockResolvedValueOnce(null);
		clipboardTextMock.readClipboardText.mockRejectedValueOnce(new Error("text unavailable"));
		const context = makeContext();

		await getHandleClipboardPaste().call(context);

		expect(context.showStatus).toHaveBeenCalledTimes(1);
		expect(String(context.showStatus.mock.calls[0]?.[0])).toContain("Clipboard paste failed");
	});

	it("stays quiet when the clipboard is simply empty", async () => {
		clipboardImageMock.readClipboardImage.mockResolvedValueOnce(null);
		clipboardTextMock.readClipboardText.mockResolvedValueOnce(null);
		const context = makeContext();

		await getHandleClipboardPaste().call(context);

		expect(context.showStatus).not.toHaveBeenCalled();
		expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
		expect(context.sessionLogger.warn).not.toHaveBeenCalled();
	});
});
