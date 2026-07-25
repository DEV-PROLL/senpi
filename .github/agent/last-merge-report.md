# Upstream Merge Report

- Result: clean PR-ready branch
- Upstream release tag: `v0.82.1`
- Upstream release tag SHA: `b4f293684bba718d59cc1157679bcf6157b3a7f5`
- Merged upstream/main SHA: `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`
- Fork base preserved: `2d39b25bd829720f27ece7fa0e5f56efd491d61d`
- Merge commit: `7b1234f1e13acc45d33457f23acd7039b9e6cb09`
- Verification HEAD before report commit: `3b57e01a8c8950a6d70c041c11b86255b285289c`

## Commits

- `7b1234f1e` `merge: sync automation/upstream-v0.82.1-30161921665 with upstream/main`
- `bfb933f4` `sync: record upstream pin 5bc1c2c`
- `14092b6c` `docs(changelog): audit upstream 5bc1c2c`
- `74386f3c` `fix(coding-agent): align scoped selector test after upstream merge`
- `3b57e01a` `fix(ai): drop direct Bedrock Opus 5 catalog entry`

## Fork Preservation

- Preserved fork package identity, binary names, private package flags, and CalVer `2026.7.25`.
- Preserved the fork's favorite-model selector flow instead of upstream's scoped-model selector UI.
- Preserved fork issue-analysis workflow sandboxing while adding upstream's auth-refresh persistence and success gating.
- Preserved fork lockstep/package-sync policy, including storage package handling and fork package aliases.
- Preserved fork runtime behavior documented in package `changes.md` files while taking upstream improvements semantically.

## Conflict And Follow-Up Resolutions

- `package-lock.json`: took upstream during merge, then regenerated from the resolved fork manifests with `npm install --package-lock-only --ignore-scripts`.
- `packages/coding-agent/install-lock/package-lock.json` and `packages/coding-agent/publish-deps.lock.json`: regenerated using the repository scripts.
- `scripts/generate-coding-agent-install-lock.mjs`, `scripts/generate-coding-agent-shrinkwrap.mjs`, and `scripts/install-lock-validation.mjs`: kept the fork workflow compatible with npm-omitted optional platform native dependencies.
- `scripts/sync-versions.js`: kept exact/file/link/workspace/npm alias specs where appropriate, limited lockstep validation to fork-owned packages, and synced storage package dependency ranges to local workspace versions.
- `packages/evals/*`: adapted the upstream eval harness to `@code-yeongyu/senpi`.
- `packages/coding-agent/test/suite/regressions/6949-unavailable-scoped-model.test.ts`: removed the upstream-only scoped-selector regression because the fork intentionally uses `FavoriteModelsSelectorComponent` and `/favorite-models`.
- `packages/ai/src/providers/data/amazon-bedrock.json`: removed the stale direct `anthropic.claude-opus-5` Bedrock generated-catalog entry so the committed data matches the generator's inference-profile-only filter.

## Changelog Audit

- Added `packages/ai/CHANGELOG.md` `[Unreleased]` entries for Bedrock Claude Opus 5, remote catalog ETags, Radius OAuth refresh routing, `ModelsError` cause preservation, and Opus 5 adaptive-thinking/xhigh metadata.
- Added `packages/coding-agent/CHANGELOG.md` `[Unreleased]` entries for the eval harness, custom message renderer padding metadata, inherited Opus 5 catalog updates, remote catalog ETags, llama catalog cache-only refreshes, resource-loader directory filtering, fork prompt/websearch fixes, inherited Radius/ModelsError fixes, and removal of legacy eval aliases.

## QA

- `npm run build`: passed.
- `npm run check`: passed; Biome reported no fixes applied.
- `npm test`: passed after the focused Bedrock catalog fix.
- Built CLI smoke:
  - `node packages/coding-agent/dist/cli.js --version`: passed, printed `2026.7.25`.
  - `node packages/coding-agent/dist/cli.js --help`: passed.
- Senpi QA:
  - `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`: passed 9/9.
  - `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop`: passed 38/38.
  - `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test`: passed 7/7.
  - `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui`: passed 5/5.
- Evidence logs/artifacts were captured under `local-ignore/qa-evidence/20260725-upstream-v0821/`, `local-ignore/qa-evidence/20260725-upstream-agent-tui/`, and mock-loop text-leak evidence directories.

## Final Checks

- Confirmed `upstream/main` is an ancestor of `HEAD`.
- Confirmed the fork parent `2d39b25bd829720f27ece7fa0e5f56efd491d61d` is an ancestor of `HEAD`.
- Worktree was clean before writing this report.
