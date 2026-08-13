# changes

## Keep npm release installs independent of native build tooling (2026-08-13)

### What changed

- The npm release workflow now installs dependencies with `--ignore-scripts`.
- Added a workflow contract test for the no-script install command.

### Why

- The release workflow builds and tests TypeScript packages; it does not need
  Canvas or other native dependency lifecycle scripts.
- Canvas lacked a compatible prebuild on the current Linux runner and its
  source fallback required system `pangocairo` headers, failing before the
  repository's own build and test gates could run.
- Native artifacts are rebuilt explicitly in the separate binary release
  workflow where their system prerequisites are managed.

### Expected merge conflict zones

- LOW: the dependency-install step in `publish-npm.yml`.
