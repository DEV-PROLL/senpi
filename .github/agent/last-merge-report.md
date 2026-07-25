# Upstream Merge Report

## Upstream

- Upstream repo: `badlogic/pi-mono`
- Release tag: `v0.82.1`
- Release tag SHA: `b4f293684bba718d59cc1157679bcf6157b3a7f5`
- Merged upstream/main SHA: `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`
- Merge commit: `2dc7fb01a`
- Pin commit: `a03e374d7`

## Preserved fork state

- Preserved the existing fork history through `origin/main` / `main` at `b7c54ca183d17a1e97b9c9b0a615557a282d5f99`.
- Preserved fork CalVer package identity and private package metadata for `@code-yeongyu/senpi`, `@code-yeongyu/senpi-server`, and fork workspace dependencies.
- Preserved fork model-selection UX (`/favorite-models` plus legacy `enabledModels` narrowing) instead of adopting upstream's separate scoped-model selector.
- Preserved fork version-sync policy in `scripts/sync-versions.js`, including independent `pi-storage-sqlite-node` handling and local/file/npm specifier protection.

## Conflicts resolved

- `package-lock.json`: initially took upstream as instructed, then regenerated from fork-consistent manifests because upstream package identities caused npm to resolve `@earendil-works/pi-coding-agent` outside the checkout. Final lock was regenerated with `npm install --package-lock-only --ignore-scripts`.
- `packages/coding-agent/install-lock/package-lock.json` and `packages/coding-agent/publish-deps.lock.json`: regenerated with `node scripts/generate-coding-agent-install-lock.mjs` and `node scripts/generate-coding-agent-shrinkwrap.mjs`.
- `packages/*/CHANGELOG.md`: accepted upstream released sections, then restored/added required fork `Unreleased` entries during `/cl`.
- Package manifests: kept fork names, `2026.7.25` versions, private flags, fork dependencies, `senpi` bin/build behavior, and upstream non-conflicting dependency updates.
- `.github/workflows/issue-analysis.yml`: kept the fork's shell auth writer plus issue-context-file flow and removed the interleaved upstream `github-script` fragment.
- `packages/ai/scripts/generate-models.ts`, `packages/ai/src/api/bedrock-converse-stream.ts`, and related AI tests: resolved in favor of the fork's broader adaptive-thinking family coverage, including `mythos-5`.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` and `favorite-models-selector.ts`: kept the fork favorite-model selector flow; upstream's `ScopedModelsSelectorComponent` path is not present in this fork.
- `packages/coding-agent/test/suite/regressions/6949-unavailable-scoped-model.test.ts`: removed as a focused fix because it targets the upstream-only scoped-model selector component. Existing fork tests cover the fork's favorite/scoped model behavior.
- `packages/storage/sqlite-node/package.json`: kept upstream `0.82.1` package version but preserved the fork's resolvable `^0.82.0` independent package dependency pins.

## Changelog audit

- Added/restored `Unreleased` entries in:
  - `packages/ai/CHANGELOG.md`
  - `packages/agent/CHANGELOG.md`
  - `packages/coding-agent/CHANGELOG.md`
- Entries cover inherited upstream `v0.82.1` user-facing changes, fork thinking-off/server-fallback work, GPT-5.6 prompt behavior, OMO local update, config-reload fixes, websearch source rendering, and restored Claude text tool-call recovery notes required by the docs guard.

## QA

- `npm run build`: passed.
- `npm run check`: initially failed on the upstream-only scoped-model selector regression; fixed and rerun passed.
- `npm test`: initially failed on the missing Claude text tool-call recovery changelog note; fixed and rerun passed.
- Built CLI smoke:
  - `node packages/coding-agent/dist/cli.js --version`: passed, printed `2026.7.25`.
  - `node packages/coding-agent/dist/cli.js --help`: passed.
- `senpi-qa`:
  - `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`: passed 9/9.
  - `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop`: passed 38/38.
  - `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test`: passed 7/7.
  - `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui`: passed 5/5.
- Evidence paths:
  - `local-ignore/qa-evidence/20260725-mock-loop-text-leak-openai-completions-complete/receipt.json`
  - `local-ignore/qa-evidence/20260725-mock-loop-text-leak-openai-completions-truncated/receipt.json`
  - `local-ignore/qa-evidence/20260725-mock-loop-text-leak-anthropic-messages-complete/receipt.json`
  - `local-ignore/qa-evidence/20260725-mock-loop-text-leak-anthropic-messages-truncated/receipt.json`
  - `local-ignore/qa-evidence/20260725-upstream-agent-tui/tui-smoke-tmux.txt`
