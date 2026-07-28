# goal Extension Changes

## Continuity across newer user instructions (2026-07-28)

### What changed

- Rewrote the existing continuation prompt guidance so a newer user message
  amends only the active objective's conflicting parts and preserves
  non-conflicting work. An explicit replacement or redirect remains a full
  objective override.

### Expected merge conflict zones on the next sync

- LOW in `prompt.ts` if the standalone goal continuation wording changes.


## Overview
Persistent per-thread goal tracking as an in-tree builtin. Ports the standalone
`pi-goal` extension into senpi with no dependency on it, file-based persistence,
codex-aligned tool naming, and budget-driven behavior removed. An optional
`tokenBudget` is retained only as inert persistence/wire compatibility metadata.

## Elapsed ticker skips unchanged footer labels (2026-07-28)

### What changed
- `GoalElapsedTicker` remembers the last rendered `formatGoalElapsedSeconds()` label and does not call `setStatus`
  again until that visible label changes. `sync()` clears the memo before its promised immediate render, so switching
  active goals or snapshots still repaints even when their formatted elapsed labels match; `stop()` also clears it.
- The ticker still samples once per second. Seconds remain live below one minute; minute/hour/day labels refresh at
  their actual display boundary instead of repainting identical text every second.

### Why
- After one minute, `formatGoalElapsedSeconds()` intentionally omits seconds. The previous ticker nevertheless
  requested a full TUI render every second, producing up to 59 redundant renders per visible minute and compounding
  the cost of large resumed histories.

### Expected merge conflict zones on next upstream sync
- LOW in `elapsed-ticker.ts` around `sync()`, `tick()`, and lifecycle reset.
- LOW in `goal-elapsed-ticker.test.ts` around fake-timer render expectations.

||||||| 9c65526b9

## Decisive completion/blocked audits + todo completion gate (2026-07-28)

### What changed
- New `todo-gate.ts`: `openTodoTaskContents(entries)` reads the thread's latest todo phases (todotools
  `senpi.todo-state` entries / todo tool results via `getLatestPhasesFromBranchEntries`) and returns every
  non-terminal task; `openTodoCompletionError` renders the rejection message.
- `tool-registration.ts`: `update_goal {status:"complete"}` now throws while any todo task is `pending` or
  `in_progress`, naming the open tasks. `blocked` is not gated. The `update_goal` description was rewritten:
  completion requires the completion audit and is rejected while todos are open, a passing audit must call the
  tool in that same turn, and blocking demands an unmistakably clear impasse recurring for 3+ consecutive goal
  turns.
- `prompt.ts`: `buildContinuationPrompt` restructured (codex `ext/goal` continuation.md alignment, budget-free):
  Continuation behavior (objective stays intact; open todos are remaining goal work; every goal turn ends in a
  concrete action or an `update_goal` call — never a bare status narration), a Completion audit that is decisive
  in BOTH directions (uncertainty keeps working; a fully passing audit must flip to `update_goal complete` in the
  same turn), and a new conservative Blocked audit (self-question for an unmistakable impasse, three-consecutive-
  turn recurrence, never for hard/slow/uncertain work).

### Why
- Observed in real sessions (e.g. 95 `goal-continuation` entries against 2 `update_goal` calls) and reported via
  Discord: the agent loops "all done"/status narration forever without completing the goal, and abandons open
  todo items when new instructions arrive. The old prompt framed completion only as dangerous with no
  counterweight, had no blocked audit, and knew nothing about todos.

### Why extension system couldn't handle this differently
- The gate reads todo state through the public `ctx.sessionManager.getBranch()` surface, mirroring
  `compaction/todo-bridge.ts`; no core change.

### Expected merge conflict zones on next upstream sync
- MEDIUM in `prompt.ts` and the `update_goal` description if standalone `pi-goal` reworks its prompt; the
  standalone package still ships the old prompt and needs the same rewrite plus todo gate on its next sync
  (its host has no todotools builtin, so the gate needs a host-capability check there).
- LOW in `tool-registration.ts` around the complete branch and `todo-gate.ts` imports.

