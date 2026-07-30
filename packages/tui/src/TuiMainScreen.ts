import { type TUI, TuiBase } from "./tui.ts";

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase implements TUI {}
