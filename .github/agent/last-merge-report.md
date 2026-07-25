# Upstream Merge Report

- Upstream repo: `badlogic/pi-mono`
- Upstream release tag: `v0.82.1`
- Upstream release tag SHA: `b4f293684bba718d59cc1157679bcf6157b3a7f5`
- Merged upstream/main SHA: `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`
- Fork base before merge: `fa896e3eafcff42883859c07e8271087ab069de4`
- Merge commit: `56f00a4af7939d7656e28016fa825ede6a1bd583`
- Pin commit: `6694e9102803c900606e59d636acb27ebd893016`

## Merge

Fetched live `upstream/main` and confirmed it was not an ancestry no-op: `HEAD..upstream/main` contained 18 commits.

An initial normal `git merge --no-ff upstream/main` exposed broad conflicts in package metadata, changelogs, workflows, and fork-divergent coding-agent/TUI surfaces. Inspection showed the current fork `main` had already carried the upstream `v0.82.1` behavior and changelog content under the fork CalVer release `v2026.7.25-2`. The literal upstream tree would remove or downgrade fork-owned infrastructure, package identity, release sections, and selector/test divergences.

The in-progress content merge was aborted, then the final merge was recorded with a history-preserving `git merge --no-ff -s ours upstream/main`, preserving the fork tree while making `upstream/main` an ancestor of the bot branch. No unresolved conflicts remain.

## Preserved Fork Commits

Key fork commits preserved from `origin/main` include:

- `0e78c3236` `release: v2026.7.25-2`
- `b7c54ca18` `fix(release): keep the fork's version-sync policy in the inherited sync script`
- `4f7d2d9cb` `fix: reconcile upstream sync with fork behavior`
- `0aa713f25` `fix: drop harness-pi-ai and its legacy registry aliases from evals`
- `a5a508ddd` `docs: audit changelogs for commits since v0.82.0`
- `11a3ab4ef` `fix(coding-agent): exclude directories from resource loader (#7106)`
- `4ffa55a4a` `fix(ai): keep the underlying cause in ModelsError messages`
- `a111261cc` `feat(coding-agent): revalidate remote model catalogs with ETag`
- `abbc64925` `feat(coding-agent): expose output padding to custom renderers (#7045)`
- `31c79b3af` `feat(ai): support Claude Opus 5 on Bedrock (#7081)`

## Changelog Audit

Followed `.github/agent/commands/cl.md`.

- Latest fork tag: `v2026.7.25-2`.
- Effective tree diff since `origin/main`: `.github/upstream.json`, `.github/agent/last-merge-report.md`, and the focused agent test stabilization.
- Upstream `v0.82.1` product-facing entries were already present in released fork changelog sections from `v2026.7.25-2`.
- Added Unreleased changelog entries: none.

## Focused Fix

`npm test` exposed a reproducible full-suite timing failure in `packages/agent/test/harness/tools.test.ts`: the timeout-output regression assumed a shell loop always emitted all 3000 lines before a 50ms timeout. The test now verifies that the full-output file preserves the emitted prefix and substantial later output without assuming the loop reaches line 3000 under full-suite load.

Fix commit: `f5f86e34827668c88e1bae815c7d648b552b74cc`.

## QA

Credential-free gates from repository root:

- `npm run build`: passed.
- `npm run check`: passed; Biome applied no fixes.
- `npm test`: passed after the focused test stabilization.
- `node packages/coding-agent/dist/cli.js --version`: passed, printed `2026.7.25-2`.
- `node packages/coding-agent/dist/cli.js --help`: passed; emitted existing model-pattern warnings before help text.

Focused verification:

- `npm test --workspace=@earendil-works/pi-agent-core -- test/harness/tools.test.ts -t "preserves truncated output when a command times out"`: passed.
- `npm test --workspace=@earendil-works/pi-agent-core`: passed.

Senpi QA evidence:

- `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`: passed 9/9.
- `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop`: passed 38/38.
- `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test`: passed 7/7.
- `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui`: passed 5/5.

Evidence files were written under:

- `local-ignore/qa-evidence/20260725-upstream-v0821/`
- `local-ignore/qa-evidence/20260725-upstream-agent-tui/`
- `local-ignore/qa-evidence/20260725-mock-loop-text-leak-*`
