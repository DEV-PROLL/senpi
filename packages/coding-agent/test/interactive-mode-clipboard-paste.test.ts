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

import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type HandleClipboardPaste = (this: object) => Promise<void>;

function getHandleClipboardPaste(): HandleClipboardPaste {
	const handler = Reflect.get(InteractiveMode.prototype, "handleClipboardPaste");
	if (typeof handler !== "function") throw new Error("Expected InteractiveMode.handleClipboardPaste");
	return handler as HandleClipboardPaste;
}

/**
 * A real 16x16 RGB PNG. processImage() genuinely decodes, resizes and re-encodes
 * the bytes, so the fixture must be a decodable image (the WASM decoder rejects
 * degenerate 1x1 payloads) - that keeps these cases exercising the production
 * normalization path instead of its failure branch.
 */
const SAMPLE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAB0klEQVR4nA3LoQ6FIABAURrBjabJ4mjMYtLGZqDRCGw0TBS67QY63c5/vnf6EUIgBUowC1aBFhjBIbgEVuAEXhAESZAFRSDEhJxQE/PEOqEnzMQxcU3YCTfhJ8JEmsgTZfqHBbmgFuaFdUEvmIVj4VqwC27BL4SFtJAXyvIPG3JDbcwb64beMBvHxrVhN9yG3wgbaSNvlO0fduSO2pl31h29Y3aOnWvH7rgdvxN20k7eKfs/nMgTdTKfrCf6xJwcJ9eJPXEn/iScpJN8Us5/uJE36ma+WW/0jbk5bq4be+Nu/E24STf5ptz/4JEe5Zk9q0d7jOfwXB7rcR7vCZ7kyZ7i/yEiIyoyR9aIjpjIEbkiNuIiPhIiKZIjJf7Dg3xQD/PD+qAfzMPxcD3YB/fgH8JDesgP5fmHiqyoylxZK7piKkflqtiKq/hKqKRKrpT6Dy/yRb3ML+uLfjEvx8v1Yl/ci38JL+klv5T3HxqyoRpzY23ohmkcjathG67hG6GRGrlR2j90ZEd15s7a0R3TOTpXx3Zcx3dCJ3Vyp/R/+JAf6mP+WD/0h/k4Pq4P++E+/Ef4SB/5o3z/MJADNZgH60APzOAYXAM7cAM/CIM0yIMy+AEIbAcQK3fUWgAAAABJRU5ErkJggg==";

function samplePngBytes(): Uint8Array {
	return new Uint8Array(Buffer.from(SAMPLE_PNG_BASE64, "base64"));
}

function makeContext(options: { blockImages?: boolean; autoResize?: boolean } = {}) {
	const sessionLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
	let nextMarkerId = 0;
	const insertedText: string[] = [];
	return {
		editor: {
			insertTextAtCursor: vi.fn((text: string) => {
				insertedText.push(text);
			}),
			insertImageMarker: vi.fn(() => {
				nextMarkerId += 1;
				insertedText.push(`[Image #${nextMarkerId}]`);
				return nextMarkerId;
			}),
			onImageMarkersChanged: undefined as ((order: number[]) => void) | undefined,
		},
		insertedText,
		pendingImages: new Map<number, ImageContent>(),
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		sessionLogger,
		getSessionLogger: () => sessionLogger,
		// Borrowed-prototype call: a plain receiver does not inherit InteractiveMode's
		// `settingsManager` getter, so the fixture stands in for it directly.
		settingsManager: {
			getBlockImages: () => options.blockImages ?? false,
			getImageAutoResize: () => options.autoResize ?? true,
		},
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

/**
 * Regression: pasting a screenshot used to write the bytes to a temp file and
 * insert that path as literal text, so the model received an unreadable
 * `/var/folders/.../pi-clipboard-<uuid>.png` string and never the image. The
 * bytes must now travel in memory, keyed by the atomic `[Image #N]` marker id.
 */
describe("InteractiveMode clipboard paste image attachment", () => {
	it("attaches the image as a pending payload behind an atomic marker", async () => {
		clipboardImageMock.readClipboardImage.mockResolvedValueOnce({
			bytes: samplePngBytes(),
			mimeType: "image/png",
		});
		const context = makeContext();

		await getHandleClipboardPaste().call(context);

		expect(context.editor.insertImageMarker).toHaveBeenCalledTimes(1);
		expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
		expect(context.showStatus).not.toHaveBeenCalled();
		expect(context.sessionLogger.warn).not.toHaveBeenCalled();

		expect(context.pendingImages.size).toBe(1);
		const entry = context.pendingImages.get(1);
		expect(entry).toBeDefined();
		expect(entry?.type).toBe("image");
		expect(entry?.mimeType).toBe("image/png");
		expect(entry?.data).toMatch(/^[A-Za-z0-9+/=]+$/);
		expect(Buffer.from(String(entry?.data), "base64").length).toBeGreaterThan(0);
	});

	it("never inserts a temp-file path for the pasted image", async () => {
		clipboardImageMock.readClipboardImage.mockResolvedValueOnce({
			bytes: samplePngBytes(),
			mimeType: "image/png",
		});
		const context = makeContext();

		await getHandleClipboardPaste().call(context);

		const inserted = context.insertedText.join("\n");
		expect(inserted).toContain("[Image #1]");
		expect(inserted).not.toContain("/tmp");
		expect(inserted).not.toContain("/var/folders");
		expect(inserted).not.toContain("pi-clipboard-");
	});

	it("keeps marker numbering and the payload map aligned across two pastes", async () => {
		clipboardImageMock.readClipboardImage
			.mockResolvedValueOnce({ bytes: samplePngBytes(), mimeType: "image/png" })
			.mockResolvedValueOnce({ bytes: samplePngBytes(), mimeType: "image/png" });
		const context = makeContext();

		await getHandleClipboardPaste().call(context);
		await getHandleClipboardPaste().call(context);

		expect(context.editor.insertImageMarker).toHaveBeenCalledTimes(2);
		expect([...context.pendingImages.keys()]).toEqual([1, 2]);
		expect(context.insertedText).toEqual(["[Image #1]", "[Image #2]"]);
	});

	it("drops the attachment when blockImages is enabled and tells the user why", async () => {
		clipboardImageMock.readClipboardImage.mockResolvedValueOnce({
			bytes: samplePngBytes(),
			mimeType: "image/png",
		});
		clipboardTextMock.readClipboardText.mockResolvedValueOnce(null);
		const context = makeContext({ blockImages: true });

		await getHandleClipboardPaste().call(context);

		// Pinned behavior: no marker, no attachment, no temp path - and a visible
		// status so the paste is never a silent no-op.
		expect(context.editor.insertImageMarker).not.toHaveBeenCalled();
		expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
		expect(context.pendingImages.size).toBe(0);
		expect(context.showStatus).toHaveBeenCalledTimes(1);
		expect(String(context.showStatus.mock.calls[0]?.[0])).toContain("Image paste blocked");
		expect(context.sessionLogger.warn).not.toHaveBeenCalled();
	});

	it("surfaces a status and attaches nothing when the image cannot be processed", async () => {
		clipboardImageMock.readClipboardImage.mockResolvedValueOnce({
			bytes: new Uint8Array([1, 2, 3, 4]),
			mimeType: "image/tiff",
		});
		const context = makeContext();

		await getHandleClipboardPaste().call(context);

		expect(context.editor.insertImageMarker).not.toHaveBeenCalled();
		expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
		expect(context.pendingImages.size).toBe(0);
		expect(context.showStatus).toHaveBeenCalledTimes(1);
		expect(String(context.showStatus.mock.calls[0]?.[0])).toContain("Image");
	});
});

/**
 * Regression: the reconciler keeps `pendingImages` aligned with the editor's
 * visible `[Image #N]` numbers. The editor reports the surviving PRE-renumber
 * ids in reading order, so the map must be re-keyed to 1..k by position -
 * otherwise a deleted marker orphans its payload and `[Image #1]` resolves to
 * the wrong (or a removed) image at submit.
 */
describe("InteractiveMode image-marker reconciliation", () => {
	type Reconcile = (this: { pendingImages: Map<number, ImageContent> }, order: number[]) => void;

	function getReconcile(): Reconcile {
		const handler = Reflect.get(InteractiveMode.prototype, "reconcilePendingImages");
		if (typeof handler !== "function") throw new Error("Expected InteractiveMode.reconcilePendingImages");
		return handler as Reconcile;
	}

	function image(data: string): ImageContent {
		return { type: "image", data, mimeType: "image/png" };
	}

	it("renumbers surviving payloads to match the reported reading order", () => {
		const context = {
			pendingImages: new Map<number, ImageContent>([
				[1, image("AAA")],
				[2, image("BBB")],
			]),
		};

		// `[Image #1]` was deleted; the editor renumbered `[Image #2]` down to 1.
		getReconcile().call(context, [2]);

		expect([...context.pendingImages.keys()]).toEqual([1]);
		expect(context.pendingImages.get(1)?.data).toBe("BBB");
	});

	it("reorders payloads when markers are moved into a different reading order", () => {
		const context = {
			pendingImages: new Map<number, ImageContent>([
				[1, image("AAA")],
				[2, image("BBB")],
			]),
		};

		getReconcile().call(context, [2, 1]);

		expect(context.pendingImages.get(1)?.data).toBe("BBB");
		expect(context.pendingImages.get(2)?.data).toBe("AAA");
	});

	it("drops every payload when all markers are gone", () => {
		const context = { pendingImages: new Map<number, ImageContent>([[1, image("AAA")]]) };

		getReconcile().call(context, []);

		expect(context.pendingImages.size).toBe(0);
	});

	it("ignores reported ids that have no pending payload (user-typed markers)", () => {
		const context = { pendingImages: new Map<number, ImageContent>([[2, image("BBB")]]) };

		// `[Image #1]` was typed by hand and owns no attachment.
		getReconcile().call(context, [1, 2]);

		expect([...context.pendingImages.keys()]).toEqual([2]);
		expect(context.pendingImages.get(2)?.data).toBe("BBB");
	});
});
