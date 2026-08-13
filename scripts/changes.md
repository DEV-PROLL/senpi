# changes

## Fork release and publish pipeline (2026-08-13)

### What changed

- Preserved CalVer release orchestration, nine-package lockstep versioning, and
  fork-scoped publish manifest rewriting.
- Combined upstream native dependency isolation, baseline binary targets, and
  Bun bunfig-autoload protection with Senpi's binary assets and codesigning.
- Preserved local-release and publish behavior for fork package identities while
  adopting the session-backend directory rename and telemetry build order.

### Why

- Senpi publishes a different package set, version scheme, standalone binary,
  and bundled extension graph from upstream.
- Upstream build fixes remain necessary for deterministic cross-platform
  artifacts.

### Why an extension could not handle it

- Release, packaging, lock generation, and binary compilation happen outside
  the runtime extension system.

### Expected merge conflict zones

- HIGH: `release.mjs` and `release-packages.mjs`, around CalVer stamping and
  release-managed workspace lists.
- HIGH: `publish.mjs`, around manifest rewriting, source-only packages, and
  bundled workspace dependencies.
- MEDIUM: `local-release.mjs`, around package order and private package policy.
- HIGH: `build-binaries.sh`, around native dependency installation, Bun compile
  flags, embedded assets, target selection, and Darwin codesigning.
