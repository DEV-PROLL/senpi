# claude-agent-sdk extension changes

## 2026-07-30 - Forward the bounded project rules region into the SDK append

- Added `extractProjectRulesAppend()` and wired it as the third `append` entry, after AGENTS.md and skills.
- Why: this lane never sends senpi's composed system prompt. It rebuilds one from the `claude_code` preset plus `append`, so any region without a dedicated extractor is discarded. Every project rule source (`.omo/rules`, `.claude/rules`, `.cursor/rules`, `.github/instructions`) silently failed to reach the model, while AGENTS.md kept working only because `extractAgentsAppend` re-reads it from disk.
- The region is located by the rules builtin's opaque region sentinels, not by the model-facing `<project_rules>` tags: prompt content this lane does not own (context files before the block, extensions appending after it) may legitimately contain those tags and would otherwise be extracted as project rules. Rule content quoting either the sentinels or the tags is neutralized producer-side.
- The sentinels are a reserved wire literal, but nothing neutralizes them in content the rules builtin does not produce, so every sentinel candidate is structurally validated (it must open with the `<project_rules>` tag followed by the `## Project Instructions` heading and close with the tag) and rejected candidates are skipped. Without that, an `AGENTS.md` carrying a sentinel would either shadow the real block or cross-match its end sentinel and hand the model unrelated text as project rules. Replicating a complete, well-formed frame is out of scope — that is a trusted-extension boundary, not a parsing one.
- Extraction is fail-closed: a region missing its end sentinel is skipped rather than read to end-of-string, so sections appended by extensions registered after `rules` (`mcp`) are never relabelled as project rules. The forwarded append carries the `<project_rules>` envelope; the sentinels themselves are stripped.
- Why an extension could not handle it: the `append` list is assembled inside `buildClaudeAgentSdkQueryOptions`, which no extension hook can reach.
- Scope note: the other `before_agent_start` system-prompt mutations dropped by this lane (`hooks`, `compaction`, `mcp`, `terminal`, `todotools`, web search) and the project `CLAUDE.md` / parent context files are unchanged here and remain open.
- Merge-conflict risk: low. Expected conflict zones are the `append` array literal in `buildClaudeAgentSdkQueryOptions` and the extractor cluster next to `extractSkillsAppend`.

## 2026-07-30 - Terminal pre-execution denial for host-captured tools (#494)

- Added an SDK `PreToolUse` hook for the six native Claude Code tools and `mcp__custom-tools__*`.
- The hook denies before Claude Code permission handling or safe-command execution and terminates SDK processing via top-level `continue: false` alongside its terminal do-not-retry instruction.
- Senpi still captures the streamed tool call and executes it through its own validation, hook, and permission pipeline.
- Merge-conflict risk: low. Expected conflict zones are the query options and tool denial constants.

## 2026-07-27 - Initial builtin provider

- New builtin extension: Claude Agent SDK provider with native multi-account OAuth, HRW session
  affinity, mandatory stream-safe failover, `/claude-account` + `--claude-account`, RPC/app-server
  account events, and auth guidance. See `packages/coding-agent/docs/providers.md` (Claude Agent SDK)
  and `.omo/plans/claude-agent-sdk-oauth-provider.md`.
