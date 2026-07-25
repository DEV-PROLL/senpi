# Upstream Merge Report

Generated: 2026-07-25T14:28:33Z
Branch: `automation/upstream-v0.82.1-30160002491`

## Upstream

- Upstream remote: `badlogic/pi-mono`
- Upstream branch: `upstream/main`
- Upstream branch SHA: `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`
- Latest upstream release tag: `v0.82.1`
- Release tag SHA: `b4f293684bba718d59cc1157679bcf6157b3a7f5`
- Recorded pin: `.github/upstream.json` now has tag `v0.82.1`, sha `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`, synced_at `2026-07-25T13:44:06Z`.

## Merge Result

- Merge commit: `f4a4c133f Merge upstream/main`
- First parent preserved fork head: `8e5b414676689fe7e6de4b2a143dfffc26342a5d`
- Second parent is fetched upstream tip: `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`
- Final HEAD before report: `6902ba876f68fc07077f28a5fa942f243ccc8035`
- Verification: no active `MERGE_HEAD`, `rebase-merge`, or `rebase-apply`; `upstream/main...HEAD` reports `0 2169`, so upstream/main is contained in the branch.
- Push status: not pushed; `origin/automation/upstream-v0.82.1-30160002491` was not present.

## Fork Preservation

- Preserved fork package identity and CalVer package versioning (`@code-yeongyu/senpi`, `2026.7.25`) while accepting upstream source changes.
- Preserved fork-local package notes and behavior documented in `changes.md`.
- Preserved fork-only coding-agent extension behavior while porting upstream scoped-model fixes into the fork's active selector component.
- Adapted the new `packages/evals` workspace to depend on and import `@code-yeongyu/senpi`.
- Did not hand-edit `packages/ai/src/models.generated.ts` or `image-models.generated.ts`.

## Conflicts Resolved

- Lockfiles/manifests: took upstream lockfile direction where applicable, regenerated npm lock state with ignored scripts, and kept fork package naming/version policy.
- Changelogs: retained fork release bookkeeping and added only the missing Unreleased audit entry.
- Coding-agent model selection: preserved fork UI structure and ported upstream unavailable scoped-model handling into `ModelSelectorComponent`.
- Resource loading and package sync tests: adopted upstream directory/resource fixes while keeping fork-specific package and workspace rules.
- AI catalog metadata: after full tests exposed stale adaptive-thinking metadata, added runtime normalization for Claude adaptive-thinking models without editing generated catalogs.
- Bedrock model coverage: aligned tests with the merged catalog exposing both direct and inference-profile Claude Opus 5 IDs.
- No unresolved or ambiguous conflicts remain; a conflict-marker scan found none.

## Changelog Audit

- Commit: `ce7815c6a docs(changelog): audit upstream 5bc1c2c`
- Added `packages/coding-agent/CHANGELOG.md` Unreleased entry:
  - Added a private Vitest eval harness package with a root `npm run eval` wrapper for credential-gated coding-agent evaluations.
- No already released changelog sections were edited during the audit commit.

## Follow-Up Fix Commits

- `c2a88a580 fix(coding-agent): preserve unavailable scoped models`
- `6902ba876 fix(ai): infer adaptive Claude thinking metadata`

## QA

- `npm install --ignore-scripts`: passed before the final fix sequence.
- Focused AI regressions: `npm --prefix packages/ai test -- test/anthropic-adaptive-thinking-models.test.ts test/bedrock-models.test.ts test/supports-xhigh.test.ts` passed, 32 tests.
- `npm run build`: passed.
- `npm run check`: passed with no remaining formatter edits or warnings from the check gate.
- `npm test`: passed for root scripts and all workspaces. Notable summaries: scripts 62 passed; agent 289 passed, 1 skipped; AI 1302 passed, 803 skipped; coding-agent 4671 passed, 32 skipped; pty 41 passed, 3 skipped; codemode 381 passed; server 3 passed; TUI exited successfully.
- Built CLI smoke:
  - `node packages/coding-agent/dist/cli.js --version`: `2026.7.25`
  - `node packages/coding-agent/dist/cli.js --help`: exited 0 and printed help.
- senpi QA:
  - `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`: 9/9 passed.
  - `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop`: 38/38 passed.
  - `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test`: 7/7 passed.
  - `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui`: 5/5 passed.
- Evidence retained under `local-ignore/qa-evidence/`, including `20260725-upstream-agent-tui` and mock-loop text-leak receipts.

## Final State

- The worktree was clean before writing this report.
- No push, PR, tag, release, rebase, force-push, or hook bypass was performed.
