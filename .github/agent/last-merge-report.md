# Upstream Merge Report

Generated: 2026-07-25T17:23:00Z
Branch: `automation/upstream-v0.82.1-30165542207`

## Result

- Result: clean PR-ready merge.
- Upstream repo: `badlogic/pi-mono`
- Upstream tag: `v0.82.1`
- Merged upstream commit: `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`
- Merge commit: `48d75ec04 Merge upstream/main v0.82.1`
- Upstream pin commit: `735c8817a sync: record upstream pin 5bc1c2c`
- Changelog audit commit: `548bde04b docs(changelog): audit upstream 5bc1c2c`
- Focused check-warning fix commit: `ab3e61f64 fix: satisfy post-merge check warnings`
- Focused test-alignment fix commit: `5ac8d3e9e fix(ai): align bedrock opus 5 catalog test`

`.github/upstream.json` now records:

- `tag`: `v0.82.1`
- `sha`: `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`
- `synced_at`: `2026-07-25T16:55:26Z`

## Preserved Fork Work

The merge preserved the current fork branch history from `origin/main`, including recent fork PRs and commits:

- `79f78c720` Merge pull request #349 from `feat/server-fallback-receipt-abort`
- `0e903e6e3` Merge pull request #350 from `feat/omo-local-update-beta`
- `2d39b25bd` Merge pull request #348 from `feat/gpt56-prompt-diet`
- `cda42fc7f` Merge pull request #346 from `fix/websearch-source-rendering`
- `d381c964c` `fix(ai): treat Claude Opus 5 as an adaptive-thinking model`
- `883f6be15` `feat(coding-agent): route server-fallback aborts through client fallback chains`
- `672bbbd27` `feat(coding-agent): omo-local-update build pipeline, skip-stamp and notifications`
- `c56d89956` `feat(coding-agent): omo-local-update git sync engine with backup-branch dirt triage`

Fork package identity and release versioning were preserved as `@code-yeongyu/senpi` with CalVer `2026.7.25`.

## Conflict And Merge Notes

- `package-lock.json`: resolved to the upstream side first, then regenerated with `npm install --package-lock-only --ignore-scripts`.
- `bun.lock`: not present in the final tracked tree.
- `changes.md` files: fork notes were preserved.
- Fork-only builtin extension surfaces under `packages/coding-agent/src/core/extensions/builtin/**` were preserved while accepting upstream-compatible additions.
- Known fork-modified runtime surfaces were resolved semantically after reading local `changes.md` notes:
  - `packages/agent/src/agent-loop.ts`: preserved fork queue-drain suppression, truncation recovery, and abort behavior while accepting upstream loop changes.
  - `packages/coding-agent/src/core/agent-session.ts`: preserved fork compaction, fallback, and session-work lifecycle behavior while integrating upstream model/catalog changes.
  - `packages/coding-agent/src/core/model-registry.ts`, `settings-manager.ts`, and `resource-loader.ts`: preserved fork model metadata, smooth-streaming/config-reload, and trusted reload behavior.
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: preserved fork compaction queue handling, fallback notices, and `/favorite-models` behavior while adding upstream `/scoped-models`.
  - `packages/tui/src/tui.ts`: preserved fork render-throttle and differential rendering behavior.
- Upstream scoped-model selector was integrated as `ScopedModelsSelectorComponent` and `/scoped-models`; fork `/favorite-models` and Ctrl+P favorite cycling remain intact.
- Upstream private eval package was adapted to the fork namespace as `@code-yeongyu/senpi-evals` depending on `@code-yeongyu/senpi`.
- Generated lock scripts were patched to skip optional platform packages missing from the host-generated npm lock, preserving the fork policy that platform-constrained native packages are not bundled.
- Bedrock Claude Opus 5 catalog coverage was aligned with the preserved fork behavior: both `global.anthropic.claude-opus-5` and `anthropic.claude-opus-5` are expected.

## Changelog Audit

Added missing `## [Unreleased]` entries in:

- `packages/agent/CHANGELOG.md`: queued-message drain suppression for server-side fallback abort recovery.
- `packages/ai/CHANGELOG.md`: Anthropic server-side fallback receipt detection and Claude Opus 5 adaptive-thinking metadata.
- `packages/coding-agent/CHANGELOG.md`: OMO local-update beta, server-side fallback abort support, GPT-5.6 prompt diet, upstream `v0.82.1` integration, scoped-model removal fix, and websearch rendering fixes.

Already released changelog sections were not edited by the audit commit.

## QA Results

Credential-free gates from repository root:

- `npm run build`: passed.
- `npm run check`: passed after `ab3e61f64`.
- `npm --prefix packages/ai test -- test/bedrock-models.test.ts`: passed after the Bedrock assertion fix.
- `npm test`: passed after `5ac8d3e9e`.

Built CLI smoke:

- `node packages/coding-agent/dist/cli.js --version`: passed, printed `2026.7.25`.
- `node packages/coding-agent/dist/cli.js --help`: passed, printed CLI help.

Senpi QA harness evidence:

- `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`: passed 9/9. Output captured at `local-ignore/qa-evidence/20260725-upstream-v0.82.1/common-self-check.txt`.
- `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop`: passed 38/38. Output captured at `local-ignore/qa-evidence/20260725-upstream-v0.82.1/mock-loop-self-test.txt`; receipts also written under `local-ignore/qa-evidence/20260725-mock-loop-text-leak-*`.
- `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test`: passed 7/7. Output captured at `local-ignore/qa-evidence/20260725-upstream-v0.82.1/cli-smoke-self-test.txt`.
- `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui`: passed 5/5. Evidence written to `local-ignore/qa-evidence/20260725-upstream-agent-tui/tui-smoke-tmux.txt` and output captured at `local-ignore/qa-evidence/20260725-upstream-v0.82.1/tui-smoke-self-test.txt`.

Final worktree status before report commit was clean.
