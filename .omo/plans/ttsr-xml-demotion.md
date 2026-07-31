# ttsr-xml-demotion - Work Plan

## Goal

Ship and merge one PR that removes Anthropic unavailable-tool context poisoning while retaining request validity, and adds a default TTSR safety net that interrupts fabricated unavailable-tool envelopes emitted as text. Work from fresh `origin/main`, use failing-first tests, preserve existing replay behavior, prove the real CLI surface, and merge with a merge commit.

## Locked design decisions

### Part A - Anthropic demotion text

1. Keep `demoteUnavailableToolReferences()` as a request-local payload transform. Add a request-local `Set<string>` of tool names already demoted while rewriting messages. The first call for each name gets the full explanatory block; later calls with the same name get the self-closing form. No module-global state is allowed.
2. Drop `tool_use.input` completely. The builder will not accept the input argument, preventing accidental replay of patch bodies.
3. Derive the replacement-tool guidance only from `definedNames`, preserving request order. Show at most 8 names; for larger toolsets append `and N more` so a 40-tool request stays readable. For zero tools, omit a fabricated list and say to use only tools available in the current request. This keeps `packages/ai` provider-neutral and avoids hardcoded coding-agent tool names.
4. Escape XML attribute values with the standard five entities (`&`, `<`, `>`, `"`, `'`) so exotic MCP tool names cannot terminate or forge the envelope.
5. Preserve ordinary tool-result text byte-for-byte inside the element. Neutralize only literal closing-tag openers `</unavailable-tool-result` by replacing the opening `<` with `&lt;`; this is the minimum change that prevents a result from forging the envelope terminator while retaining all non-conflicting result content verbatim. Existing result text such as `Done!` and `dragged to 10,20` remains unchanged.
6. Move the builders to `packages/ai/src/utils/unavailable-tool-text.ts` and import them into `anthropic-messages.ts`. `src/utils/` is not package-exported, so the helpers remain internal while avoiding any growth in the already 1928-pure-LOC adapter. The old inline input serializer/builders are removed.

### Part B - builtin TTSR rule

1. Add a dedicated builtin-rule module returning a typed `TtsrRule` with source `builtin`. Register builtin rules in `ensureInitialized()` before discovered global/project rules.
2. Duplicate-name precedence is deliberate: builtin names are reserved and win because `TtsrManager.addRule()` is first-wins. A project/global file with the same name is inspectable on disk but cannot weaken the shipped safety rule. Record this policy in the TTSR changes file.
3. Add two regex conditions: one for `<unavailable-tool-call ...>` (including full and self-closing forms) and one for the persisted legacy `[Called tool "..." (no longer available in this session)` prefix. Do not add a raw `*** Begin Patch` condition because it would false-positive on legitimate prose explaining patch syntax.
4. Scope the rule explicitly to text only: `allowText: true`, `allowThinking: false`, `toolScopes: []`. Use `interruptMode: "always"` and action-oriented content telling the model to call its real tools and redo the interrupted step.
5. Make `TtsrManager.addRule()` reject names present in `settings.disabledRules`. Existing `StreamWatcher.disabledBuiltin` continues to gate the two detector-only builtins; manager-backed builtin/project/global rules use the settings gate. This makes `--ttsr-rules-disabled=<name>` work for the new builtin through the real registration path.
6. Remove both `TTSRDBG` `console.log` calls. Partition manager-held rules by `source` in `/ttsr`: manager builtins appear in the builtin section clearly labeled as stream rules, while only project/global rules feed `USER RULES`. This preserves the truthful `USER RULES\n(none)` contract when no user files exist.

## LEAD INPUT INCORPORATED

- **disabledRules gap:** `TtsrManager.addRule()` will reject names in `settings.disabledRules`. Registration-time gating is chosen so `/ttsr` truthfully shows only loaded/active manager rules, and the same repair makes the existing flag effective for project/global rules as well as the new builtin. C3 tests will drive the identical fabricated text with the flag unset (abort + nudge) and set (no abort, no nudge).
- **per-request state:** first-vs-later tracking is a `Set<string>` allocated inside each `demoteUnavailableToolReferences()` invocation. No module-level mutable state is introduced, so concurrent and sequential requests cannot contaminate one another.
- **result-text escaping:** ordinary result text remains verbatim, but every literal `</unavailable-tool-result` closing-tag opener is narrowly neutralized to `&lt;/unavailable-tool-result`. This blocks attacker-controlled file/stdout/web content from escaping the envelope while preserving normal text such as `dragged to 10,20` unchanged.
- **non-public helper extraction:** demotion builders live in `src/utils/unavailable-tool-text.ts`, not wildcard-exported `src/api/`, so `anthropic-messages.ts` shrinks instead of growing.
- **status partition:** `/ttsr` separates manager builtins from project/global user rules. Existing `USER RULES\n(none)` behavior remains correct and the C5 CLI proof can visibly identify the new builtin stream rule.

## Failing-first and atomic delivery

### Increment 1 - Part A (C1/C2)

- Add a new fake-Anthropic-client request-path test file without editing `anthropic-tool-reference-integrity.test.ts`.
- Test first/full vs later/self-closing per name, runtime available-tool guidance, absent input payload, escaped exotic names, preserved result text, and closing-tag neutralization.
- Run the new test before production edits and save RED output.
- Implement the smallest payload-transform change, add `packages/ai/src/changes.md`, run the new test plus the existing integrity test GREEN, diagnostics, and commit.
- Commit subject: `fix(ai): reshape unavailable Anthropic tool demotion`

### Increment 2 - Part B (C3)

- Add real faux-provider harness tests in `packages/coding-agent/test/suite/ttsr-extension.test.ts` for default registration, both new and legacy text envelopes causing abort -> `<system-interrupt>` -> retry, text-only scope, and `ttsr-rules-disabled` disabling the builtin.
- Run the focused test before production edits and save RED output.
- Add builtin registration, manager disabled-rule gating, debug-log cleanup, status coverage, and `ttsr/changes.md`.
- Run focused TTSR tests GREEN, diagnostics, and commit with the required plan footer.
- Commit subject: `fix(ttsr): interrupt fabricated unavailable-tool calls`
- Footer: `Plan: .omo/plans/ttsr-xml-demotion.md`

## Verification and evidence map

Evidence root: `local-ignore/qa-evidence/20260731-ttsr-xml-demotion/`

- C1: `c1-anthropic-red.log`, `c1-anthropic-green.log`
- C2: `c2-integrity-baseline.log`, `c2-integrity-green.log`
- C3: `c3-ttsr-red.log`, `c3-ttsr-green.log`, `c3-ttsr-directory-green.log` (entire `packages/coding-agent/test/ttsr/` regression surface)
- C4: `c4-regression-baseline.log`, `c4-regression-green.log` (baseline and post-change must both be 29/29; these are characterization/regression tests, so intentional RED mutation is not appropriate)
- C5: `c5-cli-red.log`, `c5-cli-green.log`, plus the real TUI/CLI capture proving `/ttsr` lists the builtin rule from the built CLI
- Final: `root-check.log`, `focused-tests.log`, `git-diff-check.log`, `pr-ci.txt`, `merge.txt`

C5 will use the senpi-qa isolation helpers and a PTY/tmux drive of the built CLI. The pre-change drive must fail to find the new builtin name; the post-change drive must find it. Real auth must remain unchanged.

## Todo ledger

- [x] Read all binding AGENTS files and relevant source/tests/changes/QA skill.
- [x] Fetch `origin` and create dedicated worktree from fresh `origin/main`.
- [x] Inspect commit conventions and touched-path history.
- [x] Decide request-local first/later state, tool-list cap/fallback, XML neutralization, builtin precedence, disable gating, and regex scope.
- [x] Register the ULW goal and criteria.
- [x] Create evidence directory and capture C2/C4 baseline GREEN logs.
- [x] Add Part A failing tests only; capture C1 RED.
- [x] Implement Part A and changes entry; capture C1/C2 GREEN.
- [x] Run Part A package build/format validation.
- [ ] Commit atomic increment 1.
- [ ] Add Part B failing tests only; capture C3 RED.
- [ ] Capture C5 pre-change CLI RED proof.
- [ ] Implement Part B, debug-log cleanup, and changes entry.
- [ ] Capture C3 GREEN and focused TTSR suite GREEN.
- [ ] Run Part B diagnostics and commit atomic increment 2 with plan footer.
- [ ] Run C4 post-change regressions (29/29).
- [ ] Run all affected tests directly and save combined evidence.
- [ ] Run root `npm run check` and `git diff --check`.
- [ ] Build and run real senpi-qa CLI proof; capture `/ttsr` builtin listing.
- [ ] Audit diff, evidence, plan checklist, XML escaping, per-request state, and disabled-rule path.
- [ ] Push branch and open reviewer-readable PR; report URL immediately.
- [ ] Monitor CI, address review/CI findings with additional atomic green commits if needed.
- [ ] Merge PR with a merge commit and record merge SHA.
- [ ] Remove/prune dedicated worktree.
- [ ] Report PR URL, merge SHA, plan path, evidence paths, and commit list.

## Scope exclusions

No changes to the gpt-apply-patch model gate, custom wire-name aliasing, unexpected-stop classification, raw patch-pattern detection, or unrelated code.
