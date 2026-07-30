# Upstream Merge Report

## Result

- Result: CLEAN_PR_READY
- Upstream repo: badlogic/pi-mono
- Upstream release tag: v0.83.0
- Upstream release tag SHA: 845d6ff1f6643aba440341cce877ce1c43ebbc39
- Merged upstream main SHA: 71efc6f0c1909874ec8c944637a9ae7fc0e2d508
- Merge commit: 6af97e50b57bad5c55c515de2ceaa60387dd775a
- Post-merge fix commit: 335b2d075800b1437910e12f65f59921abad5816
- Upstream ancestry: confirmed upstream/main is an ancestor of HEAD.
- Upstream range: `HEAD..upstream/main` is empty.

## Pin

- Updated `.github/upstream.json` to tag `v0.83.0`, sha `71efc6f0c1909874ec8c944637a9ae7fc0e2d508`, synced_at `2026-07-30T01:36:28Z`.

## Preserved Fork State

- Preserved the fork branch history with a no-ff merge; no rebase or history rewrite was used.
- Preserved fork package identity and publish surfaces instead of adopting upstream package names.
- Preserved fork-only builtin extension behavior and source notes.
- Preserved the intentional removal of implicit `SYSTEM.md` / `APPEND_SYSTEM.md` discovery, while keeping explicit file-backed prompt source reporting.
- Preserved fork RPC command routing in `connection-handler.ts` and fork terminal image/text fallback behavior.

## Conflicts Resolved

- `package-lock.json`: reconciled to the fork package graph and regenerated with `npm install --package-lock-only --ignore-scripts`.
- `packages/coding-agent/npm-shrinkwrap.json`: kept removed per fork packaging rules.
- `changes.md` files: kept fork notes.
- Runtime fork files were merged semantically after reading applicable `changes.md` notes:
  - `packages/agent/src/agent-loop.ts`
  - `packages/coding-agent/src/core/agent-session.ts`
  - `packages/coding-agent/src/core/model-registry.ts`
  - `packages/coding-agent/src/core/settings-manager.ts`
  - `packages/coding-agent/src/core/resource-loader.ts`
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - `packages/tui/src/tui.ts`
- Post-merge focused fixes:
  - Aligned committed provider catalog data with upstream v0.83 metadata for GitHub Copilot Claude Opus 5, Qwen Token Plan reasoning controls, and Z.AI `max_tokens`.
  - Kept the generator source aligned so future model data hydration preserves Qwen Token Plan DeepSeek V4 thinking metadata.
  - Made session runtime teardown tolerate partial test-host sessions while preserving real session abort behavior.
  - Updated fork-aware tests for removed implicit prompt discovery and CI-offline network policy setup.

## Changelog Audit

Committed `docs(changelog): audit upstream 71efc6f` with Unreleased entries in:

- `packages/ai/CHANGELOG.md`
- `packages/agent/CHANGELOG.md`
- `packages/tui/CHANGELOG.md`
- `packages/coding-agent/CHANGELOG.md`

## QA

- `npm --prefix packages/ai run check:model-data`: passed.
- Focused AI tests: `test/github-copilot-anthropic.test.ts`, `test/openai-completions-tool-choice.test.ts`, `test/qwen-token-plan-models.test.ts`: 105 passed.
- Focused coding-agent tests: `test/model-runtime-registration-refresh.test.ts`, `test/resource-loader.test.ts`, `test/rpc-session-registry.test.ts`, `test/suite/agent-session-runtime.test.ts`: 67 passed.
- `npm run build`: passed.
- `npm run check`: passed, no formatter fixes applied.
- `npm test`: passed across scripts and all workspaces.
- Built CLI smoke:
  - `node packages/coding-agent/dist/cli.js --version`: passed, printed `2026.7.29-6`.
  - `node packages/coding-agent/dist/cli.js --help`: passed.
- senpi QA:
  - `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`: 9/9 passed.
  - `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop`: 43/43 passed.
  - `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test`: 8/8 passed.
  - `node .agents/skills/senpi-qa/scripts/rpc-drive.mjs --self-test`: 4/4 passed.
  - `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui`: 5/5 passed.

## Evidence

- `local-ignore/qa-evidence/20260730-upstream-agent-tui/tui-smoke-tmux.txt`
- `local-ignore/qa-evidence/20260730-mock-loop-text-leak-openai-completions-complete/receipt.json`
- `local-ignore/qa-evidence/20260730-mock-loop-text-leak-openai-completions-truncated/receipt.json`
- `local-ignore/qa-evidence/20260730-mock-loop-text-leak-anthropic-messages-complete/receipt.json`
- `local-ignore/qa-evidence/20260730-mock-loop-text-leak-anthropic-messages-truncated/receipt.json`
- `local-ignore/qa-evidence/upstream-agent/secret-files.txt`
- `local-ignore/qa-evidence/upstream-agent/tool-versions.txt`

No push, PR creation, tag creation, release script, rebase, force push, or hook bypass was performed.
