# loop-guard changes

## loop-guard: tool-call loop detection with steered reminders (2026-07-31)

- New builtin extension `loop-guard` that observes the pure tool-call stream
  (`tool_execution_start`, tool-call only — no adjacency assumption) and steers a
  `<system-reminder>` CustomMessage into the running turn when the agent loops.
- Three detectors over a 64-entry ring of `(toolName, canonicalArgsJson)` signatures
  (key-order-insensitive canonicalization), evaluated per call with priority
  identical > cycle > similar, one notice max per call:
  - `identical`: trailing run of byte-identical signature ≥ 3 → firm reminder
    ("same call ×N, the result will not change, snap out of it").
  - `similar`: trailing same-tool run ≥ 5 with mean adjacent bigram-Dice ≥ 0.85 and
    not all identical → softer attention-check reminder.
  - `cycle`: trailing period-k (k=2..6) repetition ≥ 3 full cycles with ≥ 2 distinct
    signatures → rotation-break reminder.
- Threshold evidence base: gemini-cli `LoopDetectionService` (sha256 name+args
  signatures, cycle periods 1..5, threshold 5 — but it HALTS the turn; loop-guard
  only nudges, so it fires earlier) and OpenHands stuck detector (4+ identical
  action-observation pairs, 6+ ping-pong cycles). Similarity calibrated on 400 real
  senpi sessions: productive same-tool runs (bash/eval/edit/todo) sit at mean
  adjacent bigram-Dice ~0.52–0.55 (p90 ≤ 0.72), while repetitive classes (read
  pagination, bash_output/task_output polling) sit at 0.84–0.93 — 0.85 separates them.
- Escalation gating (`NoticeGate`): fires once at threshold per pattern fingerprint,
  re-fires only when the count reaches 2× the last notified count; a fingerprint
  break clears the entry. State resets on `session_start` and on user `input`
  (interactive/rpc sources; extension-sourced input does not reset, so goal
  continuations cannot accidentally clear a tracked loop).
- Delivery: `pi.sendMessage({ customType: "loop-guard:notice", display: true,
  details }, { triggerTurn: false, deliverAs: "steer" })` — steers into the active
  turn without synthesizing a new one. TUI rendering via `pi.registerMessageRenderer`
  in the goal cache-warm Box style (bold accent title `⚠ Loop guard · …`, dim
  why-line, expanded detail line).
- Registration: appended in `builtin/index.ts` before `config-reload` (pure observer,
  never mutates payloads; MCP stays last). `builtin/AGENTS.md` inventory updated to
  27 extensions.
- Tests: `test/suite/loop-guard-detectors.test.ts` (units for canonicalization,
  similarity, all three detectors, gate escalation, tracker window) and
  `test/suite/loop-guard-extension.test.ts` (fake-pi harness: renderer registration,
  silent-on-varied-work, per-kind prompt text, escalation, input/session resets,
  rendered box content). Faux provider only; zero tokens.
- Expected merge conflict zones: LOW in `builtin/index.ts` (one import + one array
  entry); NONE in `types.ts` (no public API change); NONE elsewhere (new directory).
