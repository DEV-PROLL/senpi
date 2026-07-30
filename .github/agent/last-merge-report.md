# Upstream Merge Report

## Result

- Upstream repository: `badlogic/pi-mono`
- Upstream release tag: `v0.83.0`
- Upstream main SHA: `05558a79280a2f1356bd390a573aeb28726d26b5`
- Upstream tag SHA: `845d6ff1f6643aba440341cce877ce1c43ebbc39`
- Merge commit: `bcc501925`
- QA-fix commit before this report: `937ff3e57`
- Confirmed ancestry: `upstream/main` is an ancestor of branch `HEAD`.
- Upstream pin: `.github/upstream.json` records `v0.83.0` at `05558a79280a2f1356bd390a573aeb28726d26b5`.

## Preserved Fork Behavior

- Kept Senpi package identity and CalVer package versions (`@code-yeongyu/senpi`, `2026.7.30`) rather than upstream `0.83.0` metadata.
- Preserved committed model-provider JSON data as source for reproducible builds, with generator metadata kept in sync.
- Preserved fork removal of legacy `SYSTEM.md` and `APPEND_SYSTEM.md` discovery; explicit prompt sources still work.
- Preserved fork app-server, RPC, and Neo-mode integration shape while adopting upstream scoped-model and provider/runtime additions.
- Preserved extension API additions such as `serviceTier` while accepting upstream `scopedModels`.
- Preserved fork prompt-cache TTL utility and browser-safe compat predicates.

## Conflicts Resolved

- `package-lock.json`: restored the fork lockfile lineage after an upstream-only lock regeneration pointed at stale local package paths, then regenerated with `npm install --package-lock-only --ignore-scripts`.
- `packages/coding-agent/install-lock/package-lock.json`: regenerated with the repository install-lock generator.
- `packages/coding-agent/npm-shrinkwrap.json`: kept deleted per fork publishing rules.
- `packages/ai` provider/API files: merged upstream per-request `fetch` injection and raw stop metadata with fork auth, cache, and adaptive-thinking behavior.
- `packages/coding-agent/src/core/resource-loader.ts`: kept fork behavior that ignores legacy system-prompt discovery.
- `packages/coding-agent` runtime/RPC surfaces: retained fork app-server/RPC behavior while adding upstream scoped model plumbing.
- `packages/tui` image fallback: combined upstream shortened/hyperlinked fallback behavior with fork sanitization and width-clamping expectations.

## Changelog Audit

Added `## [Unreleased]` entries in:

- `packages/ai/CHANGELOG.md`: fetch injection, OpenRouter OAuth redirect fallback, Copilot Opus 5, raw stop metadata, Qwen/Z.AI fixes, tool argument cleanup, Bedrock profile selection, TypeBox validation, and OpenCode Go naming.
- `packages/coding-agent/CHANGELOG.md`: auth commands, scoped models, eval scenarios, offline tests, startup context, UI/runtime/RPC fixes, eval diagnostics, llama.cpp usage, and upstream provider/TUI integrations.
- `packages/tui/CHANGELOG.md`: shortened and hyperlinked image fallback paths plus fallback width clamping.

## Follow-up Fix Commits

- `738d4f62b fix: resolve upstream merge build fallout`
- `cd7fe27bc fix: satisfy upstream merge checks`
- `937ff3e57 fix: resolve upstream QA fallout`

The final fix commit repaired catalog metadata, fork-aware tests, partial-session teardown tolerance, and TUI image fallback wiring.

## QA Results

- `npm run build`: passed.
- `npm run check`: passed; Biome fixed one intentional file before the final fix commit.
- `npm test`: passed.
- Built CLI smoke:
  - `node packages/coding-agent/dist/cli.js --version`: `2026.7.30`
  - `node packages/coding-agent/dist/cli.js --help`: passed.
- Senpi QA receipts:
  - `local-ignore/qa-evidence/20260730-upstream-v0830/common-self-check.txt`: `9/9 passed`
  - `local-ignore/qa-evidence/20260730-upstream-v0830/mock-loop-self-test.txt`: `43/43 passed`
  - `local-ignore/qa-evidence/20260730-upstream-v0830/cli-smoke-self-test.txt`: `8/8 passed`
  - `local-ignore/qa-evidence/20260730-upstream-v0830/tui-smoke-self-test.txt`: `5/5 passed`
  - `local-ignore/qa-evidence/20260730-upstream-agent-tui/tui-smoke-tmux.txt`

No push, pull request, tag, rebase, force-push, or release command was run.
