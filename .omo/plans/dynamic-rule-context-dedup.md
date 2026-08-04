# Dynamic Rule Context Deduplication

## Goal

Inject each unchanged dynamic project rule at most once while it remains in the
live agent context. An accepted compaction clears that knowledge boundary so the
rule can be injected again. A changed rule body must also inject again before
compaction.

## Root Cause

The rules builtin stores dynamic deduplication as a map keyed by target path.
Reading a second file that matches the same rule creates a new target key, so
the unchanged rule is appended to the second tool result and a second
`Project rules` activation notice is recorded.

## Design

1. Replace target-scoped dynamic dedup state with a session-wide set keyed by
   canonical rule path plus content hash.
2. Remove the target-path parameter from the private cache, engine, and
   extension call sites.
3. Keep the existing accepted `session_compact` reset unchanged.
4. Keep content hashes in the dedup key so live rule edits are not hidden.
5. Record the Senpi-specific vendored adaptation and re-vendor conflict zones.

## Test-First Sequence

1. Add a focused regression test outside the near-limit legacy rules test file.
2. Capture RED: two distinct matching targets append the same rule twice.
3. Characterize rejected compaction, accepted compaction, and changed-content
   behavior.
4. Apply the smallest cache and private API change.
5. Capture GREEN for all focused scenarios.

## Verification

- Focused Vitest regression file.
- LSP diagnostics for every changed TypeScript file.
- Pure LOC measurement and TypeScript architecture self-review.
- Root `npm run check`, relevant tests, and root build.
- Real source-built Senpi CLI with an isolated fake model server:
  - two matching files produce one unchanged-rule injection and one activation;
  - changing the rule produces one updated injection.
- Production extension-runner driver:
  - rejected compaction keeps suppression;
  - accepted compaction restores injection.
- Cleanup receipt proves no QA server, port, sandbox, or worktree remains.

## Delivery

Ship through `fix/dynamic-rule-context-dedup` into `main` with a reviewer-readable
PR, green CI, Cubic approval or an explicit quota-exhausted skip, merge commit,
and task-worktree removal.
