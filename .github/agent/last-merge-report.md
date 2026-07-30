# Upstream Merge Report

## Result

- Result: clean PR-ready branch after focused merge repairs.
- Upstream release tag: `v0.83.0`
- Upstream tag object/commit resolved locally: `845d6ff1f6643aba440341cce877ce1c43ebbc39`
- Merged upstream main SHA: `c13ffe1877c3a47ce9f2fc98d9880447d64a0e87`
- Merge commit: `b89940d24d670edd4b710d59eb6621a8b86949e9`
- Merge parents: fork `77a768096`, upstream `c13ffe187`
- Upstream pin commit: `516dd4403 sync: record upstream pin c13ffe1`
- Changelog audit commit: `d3734bcef docs(changelog): audit upstream c13ffe1`
- Focused repair commit: `6030cec62 fix: resolve upstream merge regressions`

## Fork Preservation

The merge preserved the fork branch history from `origin/main`, including recent compaction, goal-continuation, risky-model-warning, and Kimi XTML recovery commits. The merge kept Senpi package identity and fork-specific runtime behavior, including explicit-only resource-loader prompt sources, the split RPC connection handler, and the fork TUI renderer with upstream alternate-screen support integrated as `TuiAltScreen`.

## Conflict And Repair Notes

- No unresolved merge conflicts remain.
- `packages/coding-agent/test/resource-loader.test.ts` was adjusted to assert the fork policy: no automatic `SYSTEM.md` or `APPEND_SYSTEM.md` discovery.
- `packages/ai/scripts/generate-models.ts` and generated provider catalogs were synchronized for Copilot Claude adaptive thinking, Z.AI `max_tokens`, and Qwen Token Plan thinking payload behavior.
- `packages/ai/src/api/anthropic-messages.ts` preserves upstream sensitive-stop parsing while surfacing the expected provider stop error.
- `packages/coding-agent/src/core/extensions/loader.ts` carries path aliases into source-mode Jiti loading.
- `packages/coding-agent/src/core/agent-session-runtime.ts` tolerates partial test sessions without an `abort` method.
- `packages/coding-agent/src/modes/interactive/help-content.ts` recognizes `tui.altScreen.*` keybinding help groups.
- `packages/tui/src/terminal-text.ts` restores image fallback home-shortening and OSC 8 file hyperlinks.
- `packages/tui/src/tui.ts` restores the public `compositeLineAt()` wrapper over `compositeTuiLine()`.

## Changelog Audit

Added `## [Unreleased]` entries to:

- `packages/ai/CHANGELOG.md`
- `packages/agent/CHANGELOG.md`
- `packages/coding-agent/CHANGELOG.md`
- `packages/tui/CHANGELOG.md`

No released changelog sections were edited.

## QA

- `npm run build`: passed.
- `npm run check`: passed, then rerun clean with no formatter writes.
- `npm test`: passed.
- Built CLI smoke:
  - `node packages/coding-agent/dist/cli.js --version`: passed, printed `2026.7.30`.
  - `node packages/coding-agent/dist/cli.js --help`: passed.
- Senpi QA harness:
  - `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`: passed, 9/9.
  - `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop`: passed, 43/43.
  - `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --run "say hello" --evidence upstream-agent-mock-loop`: passed, evidence in `local-ignore/qa-evidence/20260730-upstream-agent-mock-loop`.
  - `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test`: passed, 8/8.
  - `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui`: passed, 5/5; evidence in `local-ignore/qa-evidence/20260730-upstream-agent-tui`.

