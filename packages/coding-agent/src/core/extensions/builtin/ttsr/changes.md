# TTSR Fork Tracker

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
