# Tool Search Builtin Changes

## 2026-08-11 - Anthropic native deferral for searchable extension tools

### What changed

- Added a generalized Anthropic Messages native tool-search adapter under the shared tool-search builtin.
- Inactive searchable definitions are injected from the live catalog with their registered JSON Schema and `defer_loading: true`; injected tools never receive `cache_control`.
- MCP documents remain additionally gated by MCP's resolved `nativeToolSearch` setting, while extension documents require no user setting.
- Active extension tools, the local `tool_search` tool, gated tools absent from the catalog, and malformed definitions without parameters remain untouched.
- Anthropic 400 responses disable native injection for the remainder of the session and preserve local `tool_search` fallback.

### Why

- Search-exposed extension tools are intentionally absent from ordinary request tool arrays, so native deferral must supply their schemas without promoting them first.
- Catalog membership replaces MCP name-prefix heuristics and keeps eligibility tied to the same lazy-activation contract as local search.

### Expected merge conflict zones

- MEDIUM: `index.ts` provider-request lifecycle wiring.
- LOW: `native-search.ts` Anthropic payload hard rules.

## 2026-08-11 - Dormant shared catalog, promotion, and rehydration service

### What changed

- Added a session-scoped generalized catalog service that accepts MCP feeder documents and computes extension documents live from normalized `getAllTools()` metadata.
- Added additive extension promotion, eval/code-mode lazy activation, and ownership-aware v2 marker replay once per catalog generation.
- Authored the shared `tool_search` definition with generalized source/group filters and legacy `server` argument mapping.
- Registered the builtin lifecycle wiring without registering the shared tool definition; MCP retains its existing registration until the atomic feeder swap.

### Why

- Extension search exposure needs the shared engine loaded before MCP is rewired, while duplicate builtin tool registrations would make winner precedence unsafe during the transition.
- Catalog-owned activation keeps gated tools absent and routes every match through its source hook so MCP stub swapping can be preserved in the next increment.

### Expected merge conflict zones

- MEDIUM: `index.ts` will register the authored tool when MCP drops its legacy registration.
- MEDIUM: `service.ts` feeder and rehydration paths will gain MCP ownership in the same swap.
