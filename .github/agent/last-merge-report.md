# Upstream Merge Report

Date: 2026-07-25T18:03:32Z

## Upstream

- Upstream repo: `badlogic/pi-mono`
- Requested release tag: `v0.82.1`
- Release tag SHA: `b4f293684bba718d59cc1157679bcf6157b3a7f5`
- Merged upstream/main SHA: `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`
- Pre-merge fork HEAD: `95a54ded455437046fab968644be800609d3081a`
- Merge commit: `8c04103a4`
- Pin commit: `b55a07a47`

## Preserved Fork Work

- Preserved the fork's CalVer package versions, `senpi` package identity, Node 24 toolchain, bundled workspace publish model, and `packages/coding-agent/publish-deps.lock.json` flow.
- Preserved fork-specific `packages/ai` thinking-off and effort-ladder behavior for Claude 5/Fable/Mythos families while accepting upstream catalog/test additions.
- Preserved `/favorite-models` and favorite-model Ctrl+P semantics, then added upstream scoped-model management as `/scoped-models`.
- Preserved fork `vitest.config.ts` aliases and CI serialization while allowing the new upstream eval workspace to use `vitest.base.ts`.
- Preserved llama.cpp sleeping-model discoverability while adding upstream cache-only startup coverage.

## Conflicts Resolved

- `.github/workflows/issue-analysis.yml`: accepted upstream workflow improvements.
- `package-lock.json`: upstream lock could not match fork package identities; restored fork lock baseline and regenerated with `npm install --package-lock-only --ignore-scripts`.
- Package manifests: kept fork package names, CalVer versions, Node 24 engines, and bundled dependencies; added upstream root `eval` script. Adapted `packages/evals` to depend on/import `@code-yeongyu/senpi`.
- `packages/storage/sqlite-node/package.json`: kept independent upstream semver package version and synced local workspace deps to `^2026.7.25`.
- `scripts/sync-versions.js`: kept upstream workspace discovery/generated-manifest skip, added fork exception for independently versioned storage, and preserved `file:`, `workspace:`, `npm:`, `*`, and exact-version specifier style.
- `packages/ai/scripts/generate-models.ts`, `packages/ai/src/api/bedrock-converse-stream.ts`, AI e2e/xhigh tests: preserved fork thinking/off compatibility and fork-updated model ids; accepted upstream adaptive model expectation additions where compatible.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: kept fork favorite selector and added upstream scoped selector with diagnostics.
- `packages/coding-agent/src/modes/interactive/components/favorite-models-selector.ts`: kept fork file and restored upstream selector as `scoped-models-selector.ts`.
- `packages/coding-agent/test/resource-loader.test.ts`: combined fork config-dir import with upstream `vi` import.
- `packages/coding-agent/test/llama-extension.test.ts`: combined fork sleeping-model behavior with upstream catalog-cache regression.
- `packages/coding-agent/vitest.config.ts`: kept fork config; upstream base remains available for new eval package.

No conflicts were left ambiguous; no merge abort was needed.

## Changelog Audit

Committed as `d40dd2ea8` (`docs(changelog): audit upstream 5bc1c2c0`).

- `packages/ai/CHANGELOG.md`: added Unreleased entries for catalog ETags, Claude Opus 5 support, Radius OAuth gateway routing, and `ModelsError` underlying causes.
- `packages/coding-agent/CHANGELOG.md`: added Unreleased entries for output padding in custom renderers, inherited Opus 5 support, eval harness, ETag catalog refreshes, Radius OAuth gateway routing, model error causes, unavailable scoped models, directory-skipping resource loading, and llama.cpp catalog persistence.
- `packages/agent/CHANGELOG.md` and `packages/tui/CHANGELOG.md`: no user-facing upstream v0.82.1 entries were required.

## QA

- `npm run build`: passed before fixes and passed again after final source/test updates.
- `npm run check`: passed after `1128ef5c5` and re-passed after `e69418492`.
- Targeted regressions:
  - `npm --prefix packages/ai test -- test/bedrock-models.test.ts`: passed.
  - `npm --prefix packages/coding-agent test -- test/suite/regressions/6949-unavailable-scoped-model.test.ts`: passed.
- `npm test`: passed after `e69418492`.
- Built CLI smoke:
  - `node packages/coding-agent/dist/cli.js --version`: `2026.7.25`
  - `node packages/coding-agent/dist/cli.js --help`: passed.
- senpi QA:
  - `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`: 9/9 passed.
  - `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop`: 38/38 passed.
  - `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test`: 7/7 passed.
  - `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui`: 5/5 passed.

Evidence directories:

- `local-ignore/qa-evidence/20260725-mock-loop-text-leak-openai-completions-complete/`
- `local-ignore/qa-evidence/20260725-mock-loop-text-leak-openai-completions-truncated/`
- `local-ignore/qa-evidence/20260725-mock-loop-text-leak-anthropic-messages-complete/`
- `local-ignore/qa-evidence/20260725-mock-loop-text-leak-anthropic-messages-truncated/`
- `local-ignore/qa-evidence/20260725-upstream-agent-tui/`

## Final Branch

- Final HEAD: `e69418492`
- Worktree status before this report: clean.
- No push, PR, tag, release, rebase, force-push, or history rewrite was performed.
