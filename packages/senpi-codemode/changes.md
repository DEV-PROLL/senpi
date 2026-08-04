# senpi-codemode fork changes

## Eval `summary` replaces `title` (2026-08-04)

### What changed

- `title` removed from the eval input surface entirely (schema, `EvalToolInput`, `EvalCellResult`, `EvalToolDetails`, renderers, detached surfaces, prompt, README, tests, QA scripts). Phase/status-event `title` is a different concept and is untouched.
- `summary` is now REQUIRED for run requests: schema property stays optional because the flat schema object is shared with the peek/stop actions, so required-ness is enforced in `parseEvalRequest` exactly like `language`/`code`, with the teaching error: `eval run requires summary — one line in the user's language: what this cell does and for what purpose`.
- The 80-char clamp runs in the `ToolDefinition`'s `prepareArguments` hook, which executes BEFORE schema validation, so an over-long summary can never become a validation error.
- The schema description carries the user-language WHAT+WHY writing guide the model reads at call time.
- Rendering: title-less header, muted summary line beneath it in transcript frames and live-update text; detached footer label is `summary ?? cellId`.
- Back-compat: callers still sending `title` keep validating (value ignored); legacy stored results (title-only details) re-render without a label and without crashing.

### Why

- `title` was decorative metadata the model rarely populated meaningfully; `summary` forces a one-line, user-language description of intent at every run, improving transcript readability and downstream debugging.
- Enforcing required-ness in the parser (not the schema) keeps the shared flat schema valid for peek/stop while still rejecting run requests that omit `summary`.

### Why this cannot be expressed externally

- The change spans the tool schema, request parser, type definitions, renderers, detached-cell manager, status events, prompt instructions, README, and all QA scripts — a single coordinated fork commit.

### Expected merge conflict zones

- `src/tool/types.ts`, `src/tool/eval-request.ts`, `src/tool/eval-tool.ts`, `src/tool/cell-runtime.ts`, `src/tool/render.ts`, `src/tool/detached-cell-manager.ts`, `src/tool/detached-cell-snapshot.ts`, `src/extension/eval-status.ts`, `src/prompt/eval-prompt.ts`, `README.md`, `test/`, `scripts/`.

## Backfill: persistent eval lifecycle and tool surface (2026-08-01)

### What changed

- Eval cells can detach, report state-aware timeouts, and reuse neither active nor completed detached cell IDs.
- Eval now has one normalized tool surface with bounded current-main status history and rich detached-cell peeks.
- Bridge aborts, reserved bridge routing, tool-schema feedback, and tool widgets are handled explicitly.

### Why

- Long-running eval work must remain observable, addressable, and safe across retries, timeouts, and UI rendering.

### Why this cannot be expressed externally

- The contracts span the persistent kernel manager, bridge routing, tool schema, detached notification state, and renderer.

### Expected merge conflict zones

- `src/tool/eval-tool.ts`, detached cell manager/state/notification files, bridge code, status events, and eval rendering/tests.

## Live elapsed footer for detached eval cells (2026-07-31)

- `src/tool/detached-cell-manager.ts`: `ManagedCell` and `EvalDetachedCellStatusEntry` gain
  `startedAtMs` (epoch ms at cell creation); the manager accepts an injectable `now`.
- `src/extension/eval-status.ts`: `formatEvalCellStatus(entries, nowMs)` appends the oldest
  cell's goal-style elapsed label (`↗ py · title (45s)`, `↗ eval 2: a, b (3m)`); the 48-char
  budget and `+N more` packing are preserved.
- `src/extension/eval-status-ticker.ts` (new): `EvalStatusTicker`, same shape as the terminal
  builtin's `MonitorStatusTicker` — 1s unref'd interval, label dedupe, stop-and-clear when the
  last detached cell settles. `src/index.ts` routes `showDetachedCells` through the ticker and
  stops it in `dropRuntime`; `SenpiCodemodeOptions` gains an optional `now` clock for tests.
- Tests: `test/eval-status.test.ts` (elapsed rendering + budget), `test/eval-status-ticker.test.ts`
  (new; interval discipline), `test/eval-status-wiring.test.ts` (footer advances 1s→2s→3s while
  a cell stays detached, clears on completion).


- `src/extension/eval-status.ts` (new): `formatEvalCellStatus(entries)` — undefined when
  no cell is detached, `↗ <lang> · <title>` for one (cellId fallback when untitled),
  `↗ eval N: <packed titles>` for many, 48-char budget with whole-label packing and a
  `+N more` tail. `EVAL_CELLS_STATUS_KEY = "eval-cells"`. Semantics mirror the terminal
  extension's monitor-status so both live watches read the same in the footer.
- `src/tool/detached-cell-manager.ts`: `EvalDetachedCellStatusEntry` plus the
  `onStatusChange` option. Emissions happen only inside `#transition` (the single
  detach/terminal boundary) and in `detach()`, so the listener always observes the
  exact live detached set; an empty array means "clear the status".
- `src/index.ts`: `showDetachedCells` publishes the formatted status through
  `ctx.ui.setStatus("eval-cells", ...)`, highlighted with `selectedBg` in tui mode and
  left plain elsewhere. Hosts that hand a partial ui surface (no theme) fall back to
  plain text instead of breaking the cell lifecycle.
- Tests: `test/eval-status.test.ts` (formatter), new `eval detached cell status
  emissions` block in `test/eval-detach.test.ts` (manager contract), and
  `test/eval-status-wiring.test.ts` (extension → footer wiring through session_start).
