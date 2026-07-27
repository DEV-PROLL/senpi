# changes — help

## Discoverable interactive help via `/help` (2026-07-27)

### What changed

- Added a builtin `/help` command that combines the getting-started primer, live keybindings, builtin commands, and loaded extension commands.
- In TUI mode, help opens as a focused overlay through `ctx.ui.custom({ overlay: true })`.
- The help component owns its viewport and handles up, down, page up, page down, and Escape so long documents remain navigable instead of relying on overlay clipping.
- Non-TUI modes return a one-line notification pointing users to TUI help and `senpi --help`.

### Why

- Usage guidance, current shortcuts, and available commands need one discoverable in-product reference without adding help output to conversation history.

### Merge-conflict zones

- `builtin/index.ts` import block and `builtinExtensions` array (one added line each).
