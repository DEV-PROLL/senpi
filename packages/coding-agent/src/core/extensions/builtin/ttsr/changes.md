# TTSR Fork Tracker

## 2026-08-04 - Render ttsr-injection records as notice boxes

### What changed and why

- New `injection-renderer.ts` registers an `EntryRenderer` for `ttsr-injection` via the shared notice kit (`src/core/extensions/notice/`). Stream-rule interventions previously surfaced only as an ephemeral `Warning:` text line at detection time; the durable injection record appended at remediation was invisible in the TUI and on resume.
- The record now renders as a warning-toned notice box: owner in the title, a remediation-specific why line (nudge truncation vs provider-error resample), and an expanded line with observed rules, remediation mode, and record time. Detection, abort, truncation, nudge, and retry flows are untouched; the pre-abort toast remains as the immediate signal.
- Tests: `test/ttsr/injection-renderer.test.ts` covers the spec mapping (both remediations, expand gating, missing data) and proves the runner exposes the renderer under `ttsr-injection`; the full `test/ttsr/` suite stays green.

### Expected merge conflict zones

- LOW: one import and one `registerEntryRenderer` line in `index.ts`; additive renderer file.

## 2026-07-31 - Interrupt fabricated unavailable-tool calls

### What changed and why

- TTSR now registers a manager-backed builtin stream rule before discovered global/project rules. It aborts assistant text that imitates either the new `<unavailable-tool-call ...>` transcript record or the persisted legacy `[Called tool "..." (no longer available in this session)` envelope, then injects an action-oriented nudge telling the model to call its real tools and redo the step.
- Both conditions are deliberately case-insensitive because model-authored imitations are not trustworthy XML. The rule is explicitly text-only (`allowThinking: false`, no tool scopes), uses `interruptMode: "always"`, and does not match raw `*** Begin Patch` prose.
- Accepted tradeoff: legitimate model prose discussing the senpi-specific `<unavailable-tool-call` envelope also triggers once per session. The default `repeatMode: "once"` caps the interruption, and remediation is a corrective nudge rather than a hard failure.
- Builtin names are registered first and therefore reserved under the manager's existing first-registration-wins duplicate policy; project/global files cannot weaken a shipped safety rule by reusing its name.
- `TtsrManager.addRule()` now rejects names in `settings.disabledRules`. This makes `--ttsr-rules-disabled` effective for manager-held builtin, project, and global rules instead of only the two detector-only builtins.
- `/ttsr` partitions manager rules by source: builtin stream rules appear under a distinct `STREAM RULES` subsection beside the detector list, while `USER RULES` contains only project/global files and remains `(none)` when none are configured.
- Removed two committed `TTSRDBG` stdout logs from the streaming path; they corrupted interactive TUI rendering.

### Coverage

- The faux-provider extension suite proves both envelope formats abort, inject `<system-interrupt>`, and retry; thinking streams remain untouched; and the same text is inert when the builtin name is disabled.
- Manager and command tests pin disabled-rule registration and truthful builtin/user status partitioning. The full `test/ttsr/` directory remains a required regression gate.

### Expected merge conflict zones

- LOW: builtin registration order and streaming debug cleanup in `index.ts`.
- LOW: additive builtin rule module, manager registration gate, and `/ttsr` source partition.

## 2026-07-29 - Port from oh-my-pi (commit cc00ab161, v17.1.8)

### Source

Ported and adapted from oh-my-pi's TTSR (time-traveling stream rules) system:

- `packages/coding-agent/src/export/ttsr.ts` — TtsrManager (per-stream buffers, regex conditions, scope tokens, repeat gating, injected-state persistence)
- `packages/coding-agent/src/session/ttsr-coordinator.ts` — TtsrCoordinator (abort/inject/resume flow)
- `packages/coding-agent/src/capability/rule.ts` — Rule frontmatter + compileRuleCondition
- `packages/coding-agent/src/prompts/system/ttsr-interrupt.md` — interrupt template
- `docs/ttsr-injection-lifecycle.md` — lifecycle documentation

Source repo: [`oh-my-pi`](https://github.com/can1357/oh-my-pi) (MIT-licensed)

### Senpi adaptations

- **Extension-only architecture**: the entire lifecycle (detection -> abort -> remediation -> retry/continue) rides senpi's existing extension API (`message_update` deltas, `ctx.abort()`, `message_end` replacement hook, `sendMessage` with `triggerTurn`). Zero changes to `packages/ai`, `packages/agent`, or `core/agent-session.ts`.
- **Durable truncation via message_end replacement**: oh-my-pi's `contextMode: "discard"` (agent.replaceMessages) is replaced by senpi's `_replaceMessageInPlace` hook (agent-session.ts:1655-1668), which mutates the finalized message in-place before persistence — strictly stronger (durable across history/resume/compaction) with zero core API changes.
- **Provider-error-equivalent retry for leakage**: control-token leakage replaces the aborted message with an empty error-shell (`stopReason: "error"`, retryable-pattern-matching `errorMessage`) so senpi's existing bounded auto-retry/backoff/model-fallback machinery resamples — no custom retry loop.
- **Synchronous streaming-path handlers**: `message_update` handlers must be synchronous (the agent-loop event pump does not await async extension handlers for streaming events); initialization (flags, manager, discovery, restore) is synchronous via `discoverTtsrRulesSync`.
- **Builtin-disable gating**: `ttsr-rules-disabled` flag gates builtin detectors by name (StreamWatcher checks the disabled set before feeding each detector).

### Deviation ledger (oh-my-pi defaults vs senpi choices)

| oh-my-pi default | senpi choice | Rationale |
|---|---|---|
| `repeatMode: "once"`, `repeatGap: 10` | Same defaults; collapse rule overrides to `after-gap: 1` | Faithful port; per-rule override for collapse |
| `contextMode: "discard"` | Truncation via `message_end` replacement | Extension-only; no core replaceMessages API |
| `interruptMode: "always"` | Same (v1 supports interrupt only; non-interrupt deferred) | Faithful port |
| `astCondition` (ast-grep structural matching) | Dropped (v1) | Needs `@ast-grep/napi` external dep senpi lacks |
| Tool-arg snapshot matching (`matcherDigest`) | Raw `toolcall_delta` JSON only | Known semantic limitation; ast-adjacent complexity cut |
| `ttsr` CLI subcommands (`test`, `scan`) | Not ported | Out of scope for v1 |
| Trigram-Jaccard + progress-lexicon channels | Deferred (phase 2) | Needs calibration data; gate on telemetry |

### Known limitations (v1)

- **Input-event cancellation seam (non-TUI)**: in non-TUI mode, `pi.on("input")` cannot preempt an armed nudge because `ctx.abort()` sets `_userAbortPromise` and `prompt()` parks on it; the input event fires only after `agent_settled`. The `session_abort` seam and TUI `onTerminalInput` seam work as designed. Documented in coordinator-races.test.ts.
- **Builtin detector repeat-gating**: builtin detectors (collapse/leak) use per-generation latch + fresh state per turn (≈ after-gap:1 behavior); they do not consult `TtsrManager` injection records for once-mode suppression across turns.
