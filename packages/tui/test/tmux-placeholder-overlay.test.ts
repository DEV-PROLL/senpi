import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { renderImage, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { TUI } from "../src/tui.ts";
import { sliceByColumn, visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

type TuiComposite = {
	compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string;
};

afterEach(() => resetCapabilitiesCache());

describe("tmux placeholder overlay compositing", () => {
	it("preserves the transfer while covering placeholder row zero", () => {
		setCapabilities({
			images: "kitty",
			trueColor: true,
			hyperlinks: true,
			tmuxPassthrough: true,
			kittyUnicodePlaceholders: true,
		});
		const image = renderImage("QUJD", { widthPx: 36, heightPx: 18 }, { maxWidthCells: 4, imageId: 0x01020304 });
		assert.ok(image?.lines);
		const firstRow = image.lines[0] ?? "";
		const tui = new TUI(new VirtualTerminal(20, 10)) as unknown as TuiComposite;

		const composited = tui.compositeLineAt(firstRow, "OVER", 0, 4, 20);

		assert.strictEqual(composited.includes("\x1bPtmux;"), true);
		assert.strictEqual(sliceByColumn(composited, 0, 4, true).includes("OVER"), true);
		assert.strictEqual(visibleWidth(composited), 20);
	});
});
