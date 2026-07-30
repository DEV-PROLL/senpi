# Upstream Merge Report

- Branch: `automation/upstream-v0.83.0-30571177813`
- Upstream tag integrated: `v0.83.0` (`845d6ff1f6643aba440341cce877ce1c43ebbc39`)
- Merged upstream main: `b889a0ce3dc08e20078b822c5380f71c4fdec6cf`
- Fork base before merge: `77a7680963f4729c7889aedce0f13c508b333c8d`
- Resulting head: `aec8134d0413f76881c990c5793b29c834a0f0b4`

## Commits

- `51ca5387a` history-preserving merge of `upstream/main`.
- `9a44adceb` recorded `.github/upstream.json` for `v0.83.0` / `b889a0c`.
- `ed29e3864` audited changelogs for upstream `b889a0c`.
- `23f08296c`, `1f6600b61`, `aec8134d0` repaired merge/build/check/test integration issues.

## Fork Behavior Preserved

- Kept Senpi package identity, binary name, config directory, package metadata, and lockfile shape.
- Preserved fork-only builtin extension behavior, service-tier extension context, hidden TUI stdout capture, proactive/goal/compaction behavior, Kimi recovery behavior, and static-header auth paths.
- Preserved the fork policy that `SYSTEM.md` and `APPEND_SYSTEM.md` are not auto-discovered; explicit prompt inputs still expose source metadata.

## Conflicts Resolved

- `package-lock.json` and coding-agent install lock were regenerated with npm after preserving fork workspace identity.
- Changelogs kept fork release history and added upstream release sections/entries where needed.
- AI provider/API conflicts were merged to keep fork auth/recovery behavior while adding upstream fetch injection and stop-reason handling.
- Coding-agent runtime, resource-loader, interactive mode, extension context, RPC, eval harness, and tests were merged semantically.
- TUI was split into `TuiBase`, `TUI`, `TuiMainScreen`, and `TuiAltScreen` while retaining fork rendering behavior and log names.
- Follow-up QA fixes covered model metadata overlays, extension aliasing, model-runtime refresh policy, help keybinding grouping, TUI fallback/alt-screen ordering, and test expectations matching fork policy.

## Changelog Audit

Added `[Unreleased]` entries to:

- `packages/ai/CHANGELOG.md`: GPT-5.6 pricing, Kimi XTML recovery, OpenCode Go naming.
- `packages/agent/CHANGELOG.md`: AgentHarness shutdown lifecycle and empty Kimi retry.
- `packages/coding-agent/CHANGELOG.md`: high-reasoning/risky model warnings, OMO tips, proactive idle compaction, eval ergonomics, goal continuation cap resets, compaction input recovery, session-title runtime key reuse, Kimi recovery, apply-patch serialization, and upstream alt-screen/setToolsExpanded entries.

## QA

Passed:

- `npm run build`
- `npm run check`
- `npm test`
- `node packages/coding-agent/dist/cli.js --version` -> `2026.7.30`
- `node packages/coding-agent/dist/cli.js --help` -> exit 0
- `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check` -> 9/9 passed
- `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop` -> 43/43 passed
- `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test` -> 8/8 passed
- `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui` -> 5/5 passed

Evidence:

- `local-ignore/qa-evidence/20260730-upstream-agent-mock-loop/mock-loop-self-test.txt`
- `local-ignore/qa-evidence/20260730-upstream-agent-tui/tui-smoke-tmux.txt`

Notes:

- CLI `--help` exited 0 but printed warnings for configured model patterns that do not currently match built-in models.
- No push, PR, tag, rebase, force-push, or release was performed.
