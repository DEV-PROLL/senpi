# Upstream Merge Report

Generated: 2026-07-31T01:45:00Z

## Result

- Merge result: clean, PR-ready after focused fixes and QA.
- Current branch: `automation/upstream-v0.83.0-30594691517`
- Current HEAD: `65132c9412379a20754d23cfa5c4b4cbcfe9032a`
- Upstream release tag: `v0.83.0`
- Upstream tag commit: `845d6ff1f6643aba440341cce877ce1c43ebbc39`
- Merged upstream main: `74caa2649f10ed71b4378ce69f5d9fbfd2466ca5`
- Pin recorded in `.github/upstream.json`: `v0.83.0` / `74caa2649f10ed71b4378ce69f5d9fbfd2466ca5`

`upstream/main` and `origin/main` are both ancestors of the final branch.

## Preserved Fork Commits

The merge preserved the fork's first-parent branch history and incorporated the prior resolved automation branch:

- `f1fff70c0` - Merge `origin/automation/upstream-v0.83.0-30571177813`
- `302df8faf` - Remove the previous transient upstream agent report
- Existing fork release and feature history from `origin/main`

New commits added for this integration:

- `9737eadd7` - Merge `upstream/main`
- `ce26e47c4` - Record upstream pin `74caa26`
- `b7867c25c` - Audit upstream changelogs
- `1c75c6bf3` - Merge OpenAI completions compatibility flags
- `b74d7414c` - Update AI completions compatibility test fixtures
- `65132c941` - Restore hook manifest discovery

## Conflict And Merge Decisions

- `package-lock.json`: took the upstream lockfile direction, then repaired the workspace lock entries after local npm lock regeneration hit an npm local-tarball path issue.
- `packages/ai/src/api/openai-completions.ts`: kept the fork's extracted `getOpenAICompletionsCompat` resolver and incorporated upstream `supportsFinishReason` and Z.ai max-token behavior.
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`: preserved the fork's assistant message descriptor reconciliation and provider-native rendering while threading upstream Markdown transformer support through it.
- `packages/coding-agent/src/core/pi-manifest.ts`: restored fork hook manifest discovery while retaining upstream package manifest validation behavior.
- Fork `changes.md` files were kept as fork notes.
- Runtime and package manager changes were resolved semantically to preserve fork behavior while adopting upstream fixes.

## Changelog Audit

Added missing `## [Unreleased]` entries:

- `packages/ai/CHANGELOG.md`
  - Preserved structured metadata for Bedrock provider errors.
  - Supported provider streams that end without finish reasons.
- `packages/coding-agent/CHANGELOG.md`
  - Duplicated the Bedrock metadata and missing-finish-reason entries for the user-facing package.
  - Added the TUI Indic conjunct grapheme width fix.

## QA Results

Credential-free gates from the repository root:

- `npm run build` - passed
- `npm run check` - passed
- `npm test` - passed
- `node packages/coding-agent/dist/cli.js --version` - passed, printed `2026.7.30`
- `node packages/coding-agent/dist/cli.js --help` - passed

Required senpi-qa evidence:

- `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check` - passed, 9/9
- `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop` - passed, 43/43
- `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test` - passed, 8/8
- `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui` - passed, 5/5

Evidence was written under `local-ignore/qa-evidence/`, including:

- `local-ignore/qa-evidence/20260731-upstream-agent-tui/tui-smoke-tmux.txt`
- `local-ignore/qa-evidence/20260731-mock-loop-text-leak-openai-completions-complete/receipt.json`
- `local-ignore/qa-evidence/20260731-mock-loop-text-leak-openai-completions-truncated/receipt.json`
- `local-ignore/qa-evidence/20260731-mock-loop-text-leak-anthropic-messages-complete/receipt.json`
- `local-ignore/qa-evidence/20260731-mock-loop-text-leak-anthropic-messages-truncated/receipt.json`
