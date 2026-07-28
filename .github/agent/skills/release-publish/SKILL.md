---
name: release-publish
description: Release, publish, CalVer tag push, npm publish, 배포, 릴리즈 for senpi. Use for the canonical release flow, GitHub tag/release publication, and npm publishing.
---

# Release Publish

Use this skill when releasing senpi with the canonical CalVer flow, pushing a release tag, publishing the GitHub Release, or publishing packages to npm.

## Canonical release flow

Run `scripts/release.mjs` from a clean `main` checkout.

- [ ] Confirm you are on `main`.
- [ ] Confirm the worktree is clean.
- [ ] Confirm the release version is a valid CalVer.
- [ ] Run the changelog audit before release.
- [ ] Make only product-facing release notes from `packages/coding-agent/CHANGELOG.md` via `scripts/release-notes.mjs`.
- [ ] Skip housekeeping, upstream-sync, and generated-catalog-only entries.
- [ ] Duplicate user-facing ai/agent/tui changes into the coding-agent changelog.
- [ ] Run `npm run check`.
- [ ] Run `npm run build`.
- [ ] Run `CI=1 npm test`.
- [ ] Create the release commit.
- [ ] Create the release tag.
- [ ] Create the next-cycle changelog commit.
- [ ] Push `main` and the tag.

## Pre-flight checklist

- [ ] Read the current release rules in `AGENTS.md` and `scripts/AGENTS.md`.
- [ ] Use a clean dedicated clone if the main checkout has foreign state.
- [ ] Never clean, stash, or otherwise disturb other people's work.
- [ ] Use the protected-main path when needed; `UPSTREAM_AUTOMATION_TOKEN` exists for authenticated protected-main pushes.
- [ ] Do not use the publish-only workflow for a normal release.
- [ ] Do not rerun `scripts/release.mjs` after the tag has been pushed.
- [ ] If checks fail before the tag push, fix first, then re-release from the beginning.
- [ ] Treat `E404` noise for `@code-yeongyu/senpi-orchestrator` as non-fatal.
- [ ] Use `node scripts/release-notes.mjs` / the cl.md audit before publishing notes.
- [ ] Keep release notes product-facing only.

## Approval checkpoint

This is the step past sessions risked forgetting.

After tag push, watch the `build-binaries` workflow run (find the run id via `gh run list --workflow=build-binaries.yml --branch main --limit 1 --json databaseId -q '.[0].databaseId'`).

After `stage-github-release`, check `publish-npm` for a pending `npm-publish` Environment deployment and approve it. Discover what is pending first, then approve:

```bash
# List pending deployments for the run (shows environment name + id)
gh api repos/code-yeongyu/senpi/actions/runs/<run_id>/pending_deployments
# Approve the npm-publish deployment
gh api repos/code-yeongyu/senpi/actions/runs/<run_id>/pending_deployments -X POST -F environment_ids[]=<id> -F comment="release approval"
```

Never consider the release done before `publish-npm` and `publish-github-release` complete and the GitHub Release is non-draft.

## Gate disambiguation

These are separate controls and must not be conflated:

- GitHub Environment approval: the `npm-publish` pending deployment gate.
- npm OIDC trusted publishing: the npm-side trusted publishing path used by the job.
- npm lifecycle-script review: the `npm approve-scripts --allow-scripts-pending` trust review, which is not publish approval.
- Protected-main authorization: the authenticated push path for protected `main`, which is distinct from publish approval.

## Hazards and hard rules

- Protected-main push failures are expected if the token path is wrong; use `UPSTREAM_AUTOMATION_TOKEN` for the authenticated release push path.
- Never use `.github/workflows/publish-npm.yml` as the normal release route; it is publish-only and bypasses the approval gate and tag/ref binding.
- Never rerun `scripts/release.mjs` after the tag is pushed. If publishing fails, recover from the existing tag workflow.
- If a check or test fails before the tag push, stop and fix the issue, then re-release. Do not try to salvage a bad release by continuing past the failure.
- `E404` noise for `@code-yeongyu/senpi-orchestrator` is not a release failure.
- **An npm PUT 404 during `npm publish` can be a false negative**: the publish may have landed anyway (observed live on 2026-07-28 with `@code-yeongyu/senpi@2026.7.28-2` — the job failed but the version exists). ALWAYS verify with `npm view <pkg> versions --json` before treating a publish error as real, before rerunning anything, and before declaring a release failed.
- A failed `publish-npm` job skips `publish-github-release` and triggers the draft-cleanup path; check `gh release view v<version>` before recovering — the release may already be live. Recover only through the existing tag workflow, never by rerunning `release.mjs`.
- If the main checkout has foreign state, use a clean dedicated clone/worktree. Never clean or stash someone else's work.

## Release notes provenance

- Extract notes only from `packages/coding-agent/CHANGELOG.md` via `scripts/release-notes.mjs`.
- Keep changelog entries product-facing.
- Run the cl.md audit before release.
- Skip housekeeping, upstream-sync, and generated-catalog-only changes.
- Duplicate user-facing ai, agent, and tui changes into the coding-agent changelog so the release notes stay complete.

## Post-release verification checklist

- [ ] `build-binaries` is complete.
- [ ] `stage-github-release` is complete.
- [ ] `publish-npm` is complete.
- [ ] `publish-github-release` is complete.
- [ ] The npm registry resolves the published version.
- [ ] The GitHub Release is published and non-draft.

## Notes

- The canonical release path is `scripts/release.mjs` from clean `main`.
- The approval checkpoint is mandatory for the normal tag-driven release.
- The publish-only workflow exists for special cases, not normal releases.
