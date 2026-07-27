# claude-agent-sdk extension changes

## 2026-07-27 - Initial builtin provider

- New builtin extension: Claude Agent SDK provider with native multi-account OAuth, HRW session
  affinity, mandatory stream-safe failover, `/claude-account` + `--claude-account`, RPC/app-server
  account events, and auth guidance. See `packages/coding-agent/docs/providers.md` (Claude Agent SDK)
  and `.omo/plans/claude-agent-sdk-oauth-provider.md`.
