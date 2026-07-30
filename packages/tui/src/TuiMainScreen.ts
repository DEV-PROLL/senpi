import type { Terminal } from "./terminal.ts";
import { TuiBase } from "./tui.ts";

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase {
	constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string) {
		super(terminal, showHardwareCursor, logDirectory);
	}
}
