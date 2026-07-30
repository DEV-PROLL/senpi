# Upstream Merge Report

## Upstream

- Upstream repo: `badlogic/pi-mono`
- Integrated tag: `v0.83.0`
- Integrated upstream main SHA: `71efc6f0c1909874ec8c944637a9ae7fc0e2d508`
- Merge commit: `af4464ef5 merge: sync upstream v0.83.0`
- Upstream pin: `.github/upstream.json` records tag `v0.83.0`, SHA `71efc6f0c1909874ec8c944637a9ae7fc0e2d508`, synced at `2026-07-30T05:32:54Z`

## Preserved Fork Behavior

- Preserved fork package identity and CalVer manifests (`@code-yeongyu/senpi`, `senpi`, `2026.7.30`) instead of adopting upstream release package names.
- Preserved fork removal of `packages/coding-agent/npm-shrinkwrap.json`.
- Preserved no implicit `SYSTEM.md` / `APPEND_SYSTEM.md` prompt discovery while keeping explicit prompt-file source reporting.
- Preserved fork RPC `connection-handler.ts` architecture rather than replacing it with upstream inline dispatcher code.
- Preserved fork AI cache/provenance/fallback behavior while adopting upstream fetch injection, pending stop reason, and raw stop reason support.
- Preserved fork model/session additions including service-tier metadata, scoped model context, runtime replacement, and app-server/RPC surfaces.

## Conflict Resolution And Follow-up Fixes

- `package-lock.json`: took upstream then regenerated with `npm install --package-lock-only --ignore-scripts`.
- Markdown fork notes (`changes.md`): kept fork-owned notes.
- Builtin extension areas: preserved fork-owned builtin directory behavior while accepting compatible upstream changes.
- `packages/ai`: restored generator/data metadata for Qwen Token Plan, Z.AI, and GitHub Copilot Claude thinking levels after the upstream catalog merge.
- `packages/coding-agent`: aligned tests with fork resource-loader prompt discovery policy, network opt-in test setup, session runtime abort interface, and persisted abort-settlement behavior.
- `packages/tui`: aligned component image fallback path shortening with terminal image fallback behavior.

## Changelog Audit

Added missing `[Unreleased]` entries for inherited upstream changes without editing released sections. Commit:

- `d23237320 docs(changelog): audit upstream 71efc6f`

## Validation

- `npm run build`: passed
- `npm run check`: passed; Biome wrote intentional formatting in edited files
- Focused regression reruns:
  - `packages/ai`: `github-copilot-anthropic`, `openai-completions-tool-choice`, `qwen-token-plan-models` passed
  - `packages/coding-agent`: `model-runtime-registration-refresh`, `resource-loader`, `rpc-session-registry`, `agent-session-runtime` passed
  - `packages/tui`: `terminal-image` path covered during the package test run
- `npm test`: passed
  - scripts: 72 passed
  - packages/agent: 303 passed, 1 skipped
  - packages/ai: 1605 passed, 804 skipped
  - packages/coding-agent: 6028 passed, 33 skipped
  - packages/pty: 41 passed, 3 skipped
  - packages/senpi-codemode: 472 passed
  - packages/server: 3 passed
  - packages/tui: passed
- Built CLI smoke:
  - `node packages/coding-agent/dist/cli.js --version`: `2026.7.30`
  - `node packages/coding-agent/dist/cli.js --help`: passed
- senpi QA:
  - `node .agents/skills/senpi-qa/scripts/lib/common.mjs --self-check`: 9/9 passed
  - `node .agents/skills/senpi-qa/scripts/cli-smoke.mjs --self-test`: 8/8 passed
  - `node .agents/skills/senpi-qa/scripts/mock-loop.mjs --self-test --evidence upstream-agent-mock-loop`: 43/43 passed
  - `node .agents/skills/senpi-qa/scripts/tui-smoke.mjs --self-test --driver tmux --evidence upstream-agent-tui`: 5/5 passed
- Evidence:
  - `local-ignore/qa-evidence/20260730-upstream-agent-tui/`
  - `local-ignore/qa-evidence/20260730-mock-loop-text-leak-openai-completions-complete/`
  - `local-ignore/qa-evidence/20260730-mock-loop-text-leak-openai-completions-truncated/`
  - `local-ignore/qa-evidence/20260730-mock-loop-text-leak-anthropic-messages-complete/`
  - `local-ignore/qa-evidence/20260730-mock-loop-text-leak-anthropic-messages-truncated/`

## Result

The branch is PR-ready after the upstream merge, pin update, changelog audit, focused merge fixes, full gates, CLI smoke, and senpi QA.
