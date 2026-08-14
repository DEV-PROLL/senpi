# config-reload Extension Changes

## Filter-aware agent-directory watch guard (2026-08-14)

### What changed

- `registrationHasRestrictedTarget` now accepts a watch rooted exactly at the agent directory when every `filterGlob` is root-anchored (a leading `/`, which matches only an immediate child of the watch root) and none of those anchored names resolves into a protected path (`auth.json`, `sessions/`, `logs/`).
- Unfiltered agent-dir targets, unanchored filters such as `omo.json` (which match at any depth), and any filter that names a protected path remain rejected (fail-closed).

### Why

- The guard predates root-anchored filters and rejected the agent directory outright even when the filters could only ever select safe root config files, so extensions could not live-watch e.g. `omo.jsonc` and had to tell users to reload manually.

### Why an extension could not handle it

- The protected-target guard runs inside this builtin at registration intake; an external extension cannot relax it.

### Expected merge conflict zones

- LOW: `index.ts` `registrationHasRestrictedTarget` and the new `isSafeFilteredAgentDirTarget`; LOW in `config-reload-extension.test.ts`.
