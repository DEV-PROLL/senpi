# Upstream Merge Report

- Completed at: 2026-07-30T04:43:42Z
- Upstream repo: badlogic/pi-mono
- Upstream release tag: v0.83.0
- Upstream tag commit: 845d6ff1f6643aba440341cce877ce1c43ebbc39
- Merged upstream/main: 71efc6f0c1909874ec8c944637a9ae7fc0e2d508
- Merge commit: 405f08f6654fd8f2d961631db18ccd4fc7c86710
- Final branch HEAD: 1b755b856a03fdc0f0ae4b1768d3d3fbde71d478

## Preserved Fork Behavior

- Kept fork package identity, CalVer package versions, the `senpi` binary/config naming, and the fork deletion of `packages/coding-agent/npm-shrinkwrap.json`.
- Preserved fork-only builtin extension behavior under `packages/coding-agent/src/core/extensions/builtin/`, including Claude Agent SDK account routing, `/btw`, `/fast`, prompt preset, permission, and launcher hardening work.
- Preserved explicit-only system prompt file policy in `DefaultResourceLoader`: legacy discovered `SYSTEM.md` and `APPEND_SYSTEM.md` files remain ignored unless passed explicitly.
- Preserved fork TUI image capability split while adopting upstream image fallback improvements.
- Preserved fork RPC/app-server extraction shape while incorporating upstream RPC account/auth command behavior.

## Conflicts Resolved

- `package-lock.json`: restored the fork lockfile shape as the base, then regenerated with `npm install --package-lock-only --ignore-scripts`.
- `packages/ai/*`: combined fork auth/header/safety behavior with upstream fetch injection, raw stop reasons, pending stop handling, and generated provider catalog expectations.
- `packages/coding-agent/src/core/*`: merged upstream session/runtime/model/resource-loader changes semantically while preserving fork `serviceTier`, prompt-source, settings-lock, and extension surfaces.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: kept fork interactive behavior and adopted upstream model-selector/status improvements.
- `packages/tui/src/*`: kept fork terminal image capability split and adopted upstream fallback rendering changes.
- `*.md` changelog files: preserved released fork history, added only `Unreleased` audit entries.

## Upstream Pin

`.github/upstream.json` now records:

- `tag`: `v0.83.0`
- `sha`: `71efc6f0c1909874ec8c944637a9ae7fc0e2d508`
- `synced_at`: `2026-07-30T03:38:57Z`

## Changelog Audit

Added `## [Unreleased]` entries for inherited upstream v0.83.0 work in:

- `packages/ai/CHANGELOG.md`
- `packages/coding-agent/CHANGELOG.md`
- `packages/tui/CHANGELOG.md`

The coding-agent changelog also records fork-side post-release fixes for `/fast`, Claude Agent SDK subscription failover, `/btw` runtime routing, and Bun launcher hardening/cross-drive coverage.

## Follow-up Fix Commits

- `0ff737c7a fix: repair upstream merge build`
- `9e20a5fba fix: satisfy upstream merge check`
- `4e9e56144 fix: align upstream merge tests`
- `1b755b856 fix: apply merge check formatting`

## QA Results

- `npm run build`: passed.
- `npm run check`: passed; Biome formatted one test expectation and that result was committed.
- `npm test`: passed.
- `node packages/coding-agent/dist/cli.js --version`: passed, printed `2026.7.29-6`.
- `node packages/coding-agent/dist/cli.js --help`: passed.
- `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`: passed 9/9.
- `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop`: passed 43/43.
- `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test`: passed 8/8.
- `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui`: passed 5/5.

Evidence written under `local-ignore/qa-evidence/`:

- `20260730-mock-loop-text-leak-openai-completions-complete/receipt.json`
- `20260730-mock-loop-text-leak-openai-completions-truncated/receipt.json`
- `20260730-mock-loop-text-leak-anthropic-messages-complete/receipt.json`
- `20260730-mock-loop-text-leak-anthropic-messages-truncated/receipt.json`
- `20260730-upstream-agent-tui/tui-smoke-tmux.txt`
