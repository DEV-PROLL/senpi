# Changelog

## [Unreleased]

### Breaking Changes

### Added

- Credential pool slot algebra under `@earendil-works/pi-ai/auth/pool/slots`: a stored credential can hold sibling slots, and `listSlots` / `upsertSlot` / `removeSlot` / `pinSlot` define slot-preserving mutation. A credential without an `accounts` array reads as a one-slot pool with no write-back, and a pooled entry keeps its flat top-level credential so older builds keep authenticating.
- `Models.logout` accepts `slotId` to remove exactly one credential slot; calling it without a slot keeps today's remove-everything behavior.

### Changed

### Fixed

### Removed

## [2026.8.24] - 2026-08-24

### Breaking Changes

### Added

### Changed

- Updated the Bedrock runtime client to 3.1116.0 and the shared TypeBox runtime to 1.3.18.

### Fixed

### Removed

## [2026.8.23] - 2026-08-23

### Breaking Changes

### Added

- Cursor Composer models receive an operating prefix as their own leading system blob, carrying this client's native tool vocabulary and completion rules in place of the Cursor-harness habits they were trained on. Other Cursor models keep their existing request shape.

### Changed

### Fixed

- Kimi XTML channel markers no longer reach user-visible assistant text when a leaked marker arrives without its trailing `<|sep|>` (seen live as a text block ending in the literal `<|close|>think` newline). One shared channel-marker grammar now backs both the stream recovery parser and message-level thinking recovery, which also strips markers from `text` blocks while keeping code-span literals intact ([#1092](https://github.com/code-yeongyu/senpi/pull/1092)).

### Removed

## [2026.8.22-2] - 2026-08-22

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.22] - 2026-08-22

### Breaking Changes

### Added

### Changed

### Fixed

- Cursor streams no longer fail while the server keeps sending heartbeats or checkpoints: the provider now matches the official Cursor CLI's stream recovery, refreshing its 30s health deadline on every inbound frame and silently retrying pre-`turnEnded` stalls or transport deaths with bounded backoff, resuming from the latest conversation checkpoint with the originally pinned model. Long-running local tools and long `xhigh` thinking turns previously died with `Cursor stream ended before turnEnded: inbound stream stalled` and immediately rotated the fallback chain.

### Removed

## [2026.8.21-3] - 2026-08-21

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.21-2] - 2026-08-21

### Breaking Changes

### Added

### Changed

### Fixed

- Cursor agent turns now finish promptly when `turnEnded` arrives even if the server leaves HTTP/2 open, while silent pre-completion streams fail after a heartbeat-aware health bound instead of freezing until the generic five-minute idle timeout.

### Removed

## [2026.8.21] - 2026-08-21

### Breaking Changes

### Added

### Changed

- Refreshed hydrated provider catalog data: vercel-ai-gateway renamed the Grok vendor slug (`xai/grok-4.5|4.6` -> `spacexai/grok-4.5|4.6`) and opencode delisted `deepseek-v4-flash-free`; prompt-preset catalog sentinels track the new ids so releases no longer fail on this drift.
- Handled the new `TOO_MANY_TOOL_CALLS` Gemini finish reason introduced by `@google/genai` 2.18.0, mapping it to an error stop reason.
- Refreshed dependency pins (`@aws-sdk/client-bedrock-runtime`, `@google/genai`, `@smithy/node-http-handler`, `typebox`) and removed the unused `chalk`, `proxy-from-env`, and `@mistralai/mistralai` dependencies.

### Fixed

### Removed

## [2026.8.20-2] - 2026-08-20

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.20] - 2026-08-20

### Breaking Changes

### Added

### Changed

### Fixed

- Skip ANTML invoke recovery when `model.api === "cursor-agent"` so native Cursor tool starts are not rejected as invalid event order ([#1013](https://github.com/code-yeongyu/senpi/pull/1013) by [@leeseunguk](https://github.com/leeseunguk)).
- Cursor MCP `task` complete no longer overwrites streamed arguments with `{}`; the last usable task args are kept ([#1017](https://github.com/code-yeongyu/senpi/pull/1017) by [@leeseunguk](https://github.com/leeseunguk)).
- Cursor conversation-id rotation now persists under the agent directory (`CODING_AGENT_DIR` or `~/.senpi/agent`) instead of `$HOME/cursor-conversation-ids.json`, so a reminted wire id survives TUI restart ([#998](https://github.com/code-yeongyu/senpi/pull/998) by [@leeseunguk](https://github.com/leeseunguk)).
- Cursor 0-token `resource_exhausted` surfaces on the first failure of a `stream()` call so the session layer can compact before any conversation-id rotation; rotation and same-stream retry apply only to later attempts ([#998](https://github.com/code-yeongyu/senpi/pull/998) by [@leeseunguk](https://github.com/leeseunguk)).
- After Cursor conversation-id rotation is skipped at the 3-rotation cap, the next `stream()` remints a fresh wire id instead of failing the session with a poisoned-conversation error, and only the dead conversation is abandoned ([#998](https://github.com/code-yeongyu/senpi/pull/998) by [@leeseunguk](https://github.com/leeseunguk)).
- Cursor 0-token `resource_exhausted` is treated as overflow without a local-estimate floor, and Cursor overflow compaction keeps no recent-token tail so the retry payload actually shrinks ([#1015](https://github.com/code-yeongyu/senpi/pull/1015) by [@leeseunguk](https://github.com/leeseunguk)).
- Cursor billed `cacheRead` that dwarfs the live conversation window is ignored: checkpoint `usedTokens` is treated as the real context size when dashboard-cumulative `cache_read_tokens` is more than 3× that window, so compaction is not fired against a multi-million cache-read figure ([#985](https://github.com/code-yeongyu/senpi/pull/985) by [@leeseunguk](https://github.com/leeseunguk)).

- Explicit Cursor thinking levels no longer die with `Connect error not_found`: Cursor's Run RPC
  rejects bare capability ids (`kimi-k3`, `claude-fable-5`, …) with `not_found`, so
  `resolveCursorSelectionDescriptor` now prefers the catalog-guaranteed suffix variant id
  (`kimi-k3-high`, `claude-fable-5-thinking-low`) whenever a legacy alias exists, keeping bare
  base id + ordered parameters only as the fallback for alias-less levels (#1008).

### Removed

## [2026.8.19] - 2026-08-19

### Breaking Changes

### Added

### Changed
- Upstream sync (`badlogic/pi-mono` main@`59a71b23`): adopted generalized thinking-token-budget fields (`thinkingTokenBudgetField`, `supportsThinkingTokenBudget`), Google thinking-level maps, Bedrock response smithy headers, Azure Responses tool-choice forwarding, and the simple tool-choice option. Fork pins (`openai@6.26.0`), Kimi top-level cached-token parsing, `-fast` priority-tier emission, and fork-only providers/catalog overlays are unchanged.
- xAI now routes through the Responses API with Grok 4.6 as the provider default, matching upstream; fork xAI model specs are preserved.
- Model catalog refreshed with upstream provider updates: Z.AI Chinese Coding Plan entries, Qwen Token Plan DeepSeek V4 Pro, Baseten GLM input modalities, and OpenRouter additions.

### Fixed

- Native Cursor turns now report real usage: the billed token split on `turnEnded`
  (input/output/cache read/cache write, taken from the production cursor-agent schema) lands on
  `usage`, and conversation checkpoints feed the server's live `usedTokens` into the in-flight
  message so context accounting and the TUI meter move mid-turn instead of showing output-only
  counts until turn end.

- `resource_exhausted` errors that arrive after tokens already streamed are classified as context
  overflow (compact-and-retry) instead of rate limit; zero-token `resource_exhausted` rejections
  keep the rate-limit path so poisoned-conversation rotation still applies.

### Removed
- Deprecated Xiaomi models dropped, and the unused `@opentelemetry/api` dependency removed from `packages/ai` (no source imports it).

## [2026.8.18-3] - 2026-08-18

### Breaking Changes

### Added

- Cursor context windows now track the models.dev first-party catalog capped by the context options
  Cursor offers each family: current Claude families and GPT 5.5/5.6 report 1M, Grok 500K, Gemini Flash
  1048576, and each request asks Cursor for the matching `context` token.

- Cursor reasoning levels: the dynamic Cursor catalog now collapses the 204 account variant ids into
  selectable base identities (Claude `base` / `base-thinking` boolean identities) with exact
  `thinkingLevelMap` ladders, live-catalog context windows (Kimi K3 1048576, GLM 5.2 1M, GPT 272K,
  Grok 256K, Claude 1M-label families 300K), and a shared cursor capability table derived from the
  2026-08-18 AvailableModels capture; explicit thinking selections render into the protobuf
  `RequestedModel.parameters` (per-family `thinking`/`context`/`effort`/`reasoning`/`fast` templates,
  GPT 5.5 / Codex 5.3 `xhigh` → `extra-high`), absent selections keep the representative variant
  request shape, and stored 204-variant catalogs migrate idempotently through the new
  `restoreModels` provider hook. Adds `ThinkingSelection` provenance propagation through agent
  state, loop turn updates, and the remote proxy.

### Changed

### Fixed

- Cursor provider: advertised MCP tool schemas are now sanitized of JSON-Schema composition
  keywords (`oneOf`/`anyOf`/`allOf`) before reaching the Run request — a single tool carrying one
  (e.g. ast-grep MCP's `scan`) made Cursor's gateway reject the whole request with a wrapped
  provider 400 (`resource_exhausted`, zero tokens) from turn 1.
- Leaked-invoke recovery now resolves upstream wire-aliased tool names (ccapi
  PascalCase disguises like `TaskSend`, CC-pool hashed prefixes like
  `mcp_49f0-Todo`, CC-SDK `mcp__server__tool` forms), so a text-leaked
  `<invoke name="mcp_49f0-Todo">` recovers into the registered `todo` tool
  call instead of rendering as literal text. Alias collisions between
  registered tools stay literal text.
### Removed

## [2026.8.18-2] - 2026-08-18

### Breaking Changes

### Added

### Changed

### Fixed

- Model recovery now preserves Cursor's in-memory resolved-tool marker on native tool-call blocks, so Claude/Kimi-id
  Cursor turns do not execute server-resolved bash/write/delete calls a second time
  ([#939](https://github.com/code-yeongyu/senpi/pull/939)).
- GPT-5.6 Sol and Sol Fast now default to a 400,000-token context window in both the direct OpenAI and
  ChatGPT OAuth (`openai-codex`) catalogs ([#933](https://github.com/code-yeongyu/senpi/pull/933)).
- Refreshed Vercel AI Gateway pricing for `alibaba/qwen3.8-27b` from zero-value placeholder metadata to the
  current upstream input, output, and cache-read rates ([#933](https://github.com/code-yeongyu/senpi/pull/933)).

### Removed

## [2026.8.18] - 2026-08-18

### Breaking Changes

### Added

### Changed

### Fixed

- xAI Grok model metadata now exposes the documented `low`/`medium`/`high`/`xhigh` effort ladder for Grok 4.6,
  sends the selected Chat Completions `reasoning_effort`, and restores the current Grok 4.20 reasoning and
  non-reasoning variants with their correct fixed-thinking behavior ([#930](https://github.com/code-yeongyu/senpi/pull/930)).

### Removed

## [2026.8.17] - 2026-08-17

### Breaking Changes

### Added

- `openai-codex` provider now ships `-fast` Priority-tier variants for GPT-5.6 sol/terra/luna, mirroring the existing `openai` provider pattern (`upstreamModelId` + `serviceTier: "priority"`, base cost rates). The Codex Responses adapter already supports Priority service tier and applies the cost multiplier at usage-accounting time, so catalog costs stay at base values to avoid double-counting.
- Cursor chat and tool calling are now fully supported through the new `cursor-agent` API: one HTTP/2 Connect stream per assistant turn against `agent.v1.AgentService/Run`, streaming text/thinking/tool-call deltas, usage from token deltas, and in-band execution of Cursor's server-driven exec channel (native read/ls/grep/write/shell frames, modern `pi_*` frames, MCP-advertised tools, kv blob store, tool-catalog handshake). Bridged tool runs are synthesized into the assistant message as already-resolved tool calls with paired results, so transcripts and the agent loop stay consistent, and the model catalog is discovered per account through `GetUsableModels` after `/login cursor` (max-mode 1M-context variants included). The Cursor protobuf schema is vendored with a regeneration script; unsupported protocol surfaces (computer use, subagents, background shells, canvas, smart-mode classification, conversation search) answer with typed refusals ([#910](https://github.com/code-yeongyu/senpi/pull/910)).

### Changed

### Fixed

- Cloudflare AI Gateway live tests now pin `claude-sonnet-5` instead of the retired `claude-sonnet-4-5` id, so root typecheck still passes after model-catalog hydration ([#925](https://github.com/code-yeongyu/senpi/pull/925)).
- Cursor's server-driven exec channel now keeps pending local tools alive with write-completion-chained 3-second
  exec heartbeats and closes every normal typed result sequence exactly once. Read, shell, MCP, and modern `pi_*`
  tool turns no longer leave the server-side exec pending until the Run stream ends before `turnEnded`
  ([#915](https://github.com/code-yeongyu/senpi/pull/915)).

### Removed

## [2026.8.16] - 2026-08-16

### Breaking Changes

### Added

- Cursor (Pro/Ultra/Teams) is now a builtin OAuth provider: `/login cursor` opens the `cursor.com/loginDeepControl` browser deep link with a PKCE S256 challenge and polls `api2.cursor.sh/auth/poll` with capped backoff until the browser approval releases the tokens; refresh exchanges the stored refresh token at `auth/exchange_user_api_key` under the credential-store lock and keeps the previous refresh token when Cursor does not rotate it. Definitive poll rejections (400/401/403/410) fail fast instead of being retried as network hiccups, the poll wait is abort-aware, and token expiry derives from the access-token JWT `exp` claim with a 5-minute refresh skew. The provider is authentication-only for now — Cursor chat runs on a protobuf Connect-RPC agent protocol that is not ported yet, so no models are exposed; the stored access token resolves through the standard auth pipeline for integrations that speak the Cursor protocol ([#905](https://github.com/code-yeongyu/senpi/pull/905)).
- GLM 5.3 is now a fully supported model family: 25 catalog entries cloned across 18 providers (alibaba-token-plan, baseten, cloudflare, fireworks, huggingface, nvidia, opencode, opencode-go, opengateway, openrouter, qwen-token-plan, together, vercel-ai-gateway, zai, zai-coding-cn), the `openai-completions` thinking-level-map matcher generalizes to cover 5.3 (`isGlm52` → `isGlm5x`), and the zai `thinkingFormat` handler forces `{type:"enabled"}` for 5.3 even when no reasoning effort is set (5.3 cannot disable thinking per the Z.AI wire contract). `generate-models.ts` was updated so regeneration preserves the 5.3 entries and their thinkingLevelMaps ([#895](https://github.com/code-yeongyu/senpi/pull/895)).

### Changed

- Synced the provider transports with upstream v0.84.2: the Anthropic streaming path now uses upstream's SSE decoder with deferred tools (`tool_reference`/`defer_loading`) and adaptive `xhigh` effort, OpenAI Completions gained strict JSON-schema conversion, grammar/custom tool calls and the new thinking backends, and the Responses transports support upstream's `additional_tools` deferred-tool mode. The fork's server-fallback receipts, retry hints, tool-choice fallback, prompt-cache TTL, deterministic tool-call-ID sanitizer and `senpi` wire identity are preserved. `mistral-conversations` moves to upstream's native transport. Provider catalog data was refreshed for the capabilities these features read (`supportsAdditionalTools`, native DeepSeek `max_tokens`, Cloudflare Responses strict mode, DeepSeek V4 Flash `low` effort), and DeepSeek base-URL detection is now case-insensitive ([#892](https://github.com/code-yeongyu/senpi/pull/892)).

### Fixed

- Stored OAuth request resolution now refreshes before availability checks, passes transient request environment through both availability and auth derivation, preserves it for replay, and respects explicit empty environment overrides ([#836](https://github.com/code-yeongyu/senpi/pull/836) by [@ismetanin](https://github.com/ismetanin)).
- Ambient-only API-key compatibility adapters can no longer outrank a valid stored OAuth credential ([#836](https://github.com/code-yeongyu/senpi/pull/836) by [@ismetanin](https://github.com/ismetanin)).
- Ambient-only authentication can now apply provider-owned request credential namespaces without importing sibling host credentials ([#836](https://github.com/code-yeongyu/senpi/pull/836) by [@ismetanin](https://github.com/ismetanin)).
- `isContextOverflow` now classifies gateway HTTP 413 byte-size rejections — "Request body too large", "Request Entity Too Large", `body_too_large`, and "Payload Too Large" — as overflow, the same recovery class as Anthropic's native `request_too_large`. Sessions whose requests exceed a gateway body limit previously saw these as terminal errors, which wedged compaction on every fallback model ([#884](https://github.com/code-yeongyu/senpi/issues/884)).

### Removed

## [2026.8.14] - 2026-08-14

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.13-2] - 2026-08-13

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.13] - 2026-08-13

### Breaking Changes

- Renamed the exported `ModelsStreamTransforms` interface to `ModelsRequestTransforms` because its header transformation now applies to all authenticated provider requests.
- Required dynamic model providers to accept a concrete `RefreshModelsContext.signal`; `Models.refresh()` remains unbounded when callers omit its optional signal.
- Required provider login, API-key check/resolution, and OAuth refresh implementations to accept a concrete abort signal; public auth and credential operations remain unbounded when callers omit their optional signal.
- Replaced raw `RefreshModelsContext.store` access with the read-only `context.stored` snapshot and generation-checked `context.publish()` transaction. `createProvider({ fetchModels })` needs no catalog-publication migration; handwritten `Provider.refreshModels()` implementations must publish restored and refreshed catalogs through `context.publish()`, passing `persist` to write (`ModelsStoreEntry`) or delete (`null`) storage and `update` for the in-memory publication.

### Added

- Added Qwen Token Plan Individual as a built-in provider with its documented subscription model catalog and the shared international `QWEN_TOKEN_PLAN_API_KEY` ([#7659](https://github.com/earendil-works/pi/pull/7659) by [@arasovic](https://github.com/arasovic)).
- Added Baseten as a built-in OpenAI-compatible provider with models.dev catalog generation and native `chat_template_args` reasoning controls.
- Added optional `OAuthAuth.isSubscription` metadata for distinguishing subscription-backed authentication from generic OAuth sign-in.
- Added explicit `TelemetryContext` propagation across stream, deferred, and image request options using the vendor-neutral `@earendil-works/pi-telemetry` contract.
- Added deferred provider request contracts, durable response handles, authenticated fetch/cancel dispatch, and faux-provider support for pending, ready, failed, and cancelled responses ([#7339](https://github.com/earendil-works/pi/pull/7339) by [@davidbrai](https://github.com/davidbrai)).
- Added arbitrary OpenAI-compatible sampling parameters through `Model.samplingParams` and `StreamOptions.samplingParams`, including per-request overrides ([#7568](https://github.com/earendil-works/pi/pull/7568) by [@mrexodia](https://github.com/mrexodia)).
- Added opt-in vLLM `thinking_token_budget` support for OpenAI-compatible models, reserving output tokens for the final answer ([#7638](https://github.com/earendil-works/pi/pull/7638) by [@bnsd55](https://github.com/bnsd55)).
- Added `OpenAICompletionsCompat.supportsFinishReason` for providers that omit streamed `finish_reason` values, inferring normal and tool-use stops when the stream ends.
- Added structured Amazon Bedrock failure diagnostics with HTTP status, modeled error code, and AWS request id when available ([#7286](https://github.com/earendil-works/pi/pull/7286) by [@brianstanley](https://github.com/brianstanley)).
- Added `ModelsStoreEntry.etag` so persisted provider catalogs can carry the remote ETag validator for conditional refreshes.
- Added `ANTHROPIC_AUTH_TOKEN` bearer authentication for Anthropic-compatible gateways ([#5871](https://github.com/earendil-works/pi/issues/5871)).
- Added Claude Opus 5 support for Anthropic and Amazon Bedrock with adaptive thinking, inference profiles, prompt caching, and preserved AWS validation messages ([#7081](https://github.com/earendil-works/pi/pull/7081) by [@unexge](https://github.com/unexge), [#7083](https://github.com/earendil-works/pi/pull/7083) by [@davidbrai](https://github.com/davidbrai)).
- Added manual redirect URL and authorization-code entry to OpenRouter OAuth login for remote and headless environments ([#7114](https://github.com/earendil-works/pi/pull/7114) by [@rgarcia](https://github.com/rgarcia)).

### Changed

- Added optional cancellation to `ModelsStore` reads, writes, and deletions; catalog orchestration binds these waits to the provider refresh signal.
- Changed Radius OAuth device authorization, token exchange, and refresh requests to use the configured gateway directly.
- Changed `ModelsError` messages to append the underlying cause, so auth failures such as `OAuth refresh failed for openai-codex` report the provider response instead of a bare wrapper message.

### Fixed

- Fixed GitHub Copilot Grok 4.5 requests to use the supported Responses API ([#7560](https://github.com/earendil-works/pi/issues/7560)).
- Bounded OAuth token refreshes so stalled requests release the credential-store lock ([#7508](https://github.com/earendil-works/pi/issues/7508)).
- Fixed tool argument validation to preserve values that already match an `anyOf`/`oneOf` union arm before attempting coercion, avoiding nullable unions converting `null` to another primitive value ([#7328](https://github.com/earendil-works/pi/issues/7328)).
- Fixed cancellation of model catalog refreshes so callers stop waiting even when a custom provider ignores its abort signal ([#7027](https://github.com/earendil-works/pi/issues/7027)).
- Fixed auth resolution, availability checks, OAuth refreshes, provider login, and in-memory credential queue waits to honor caller cancellation.
- Fixed newer provider refreshes being blocked by or overwritten by an older stalled generation, including persisted catalog publication.
- Fixed Fireworks GLM 5.2 models sending the unsupported `prompt_cache_retention` field when long cache retention is enabled, and enabled session affinity for automatic prompt caching ([#7676](https://github.com/earendil-works/pi/issues/7676)).
- Fixed the OpenCode Go provider display name.
- Fixed provider error normalization treating arrays and class instances as structured response bodies instead of preserving their original errors ([#7205](https://github.com/earendil-works/pi/pull/7205) by [@erikogenvik](https://github.com/erikogenvik)).
- Fixed Anthropic streams dropping text or thinking included in the initial content-block event ([#7358](https://github.com/earendil-works/pi/pull/7358) by [@davidbrai](https://github.com/davidbrai)).
- Fixed Google history conversion dropping signed empty text and thinking blocks required for replay ([#7362](https://github.com/earendil-works/pi/pull/7362) by [@jingtao-wisdomgraph](https://github.com/jingtao-wisdomgraph)).
- Fixed OpenAI Codex cached WebSocket sessions being shared across different account credentials ([#7364](https://github.com/earendil-works/pi/pull/7364)).
- Fixed transient Google Generative AI and Vertex AI provider errors bypassing automatic retries ([#7471](https://github.com/earendil-works/pi/pull/7471) by [@vish-pr](https://github.com/vish-pr)).
- Fixed Gemini 3 tool call ids being discarded during history conversion, breaking signed multi-turn replay ([#7494](https://github.com/earendil-works/pi/pull/7494) by [@muyiyr](https://github.com/muyiyr)).
- Fixed OpenAI Responses incomplete reasons so only `max_output_tokens` is treated as a length stop, and exposed bounded recovery detection for responses truncated below their intended output limit ([#7540](https://github.com/earendil-works/pi/pull/7540) by [@davidbrai](https://github.com/davidbrai)).
- Restored GitHub Copilot models returned through account-specific policy responses ([#7672](https://github.com/earendil-works/pi/pull/7672) by [@muyiyr](https://github.com/muyiyr)).
- Replaced the retired Qwen Token Plan `qwen3.8-max-preview` model with `qwen3.8-max` ([#7670](https://github.com/earendil-works/pi/pull/7670) by [@QuintinShaw](https://github.com/QuintinShaw)).
- Fixed Z.AI providers and compatible custom endpoints to send output limits through `max_tokens`, which those endpoints honor ([#7174](https://github.com/earendil-works/pi/pull/7174) by [@HyeokjaeLee](https://github.com/HyeokjaeLee)).
- Fixed explicitly configured Amazon Bedrock profiles being overridden by ambient AWS access keys ([#7176](https://github.com/earendil-works/pi/pull/7176) by [@christianbasch](https://github.com/christianbasch)).
- Fixed malformed OpenAI-compatible tool-call deltas with both a valid `function` payload and an empty `custom` object discarding the function arguments ([#7288](https://github.com/earendil-works/pi/pull/7288) by [@sunnyyoung](https://github.com/sunnyyoung)).

- Made `optional` keyword stripping in `google-shared.ts` schema-position-aware:
  `stripOptional()` now preserves legitimate properties named `optional` under
  `properties`/`patternProperties`/`$defs`/`definitions` and passes through value
  keywords (`const`/`default`/`examples`/`enum`) without traversing them.
  `sanitizeForOpenApi()` now recurses into array branches so `optional` inside
  `anyOf`/`oneOf`/`allOf` is stripped on the legacy Gemini `parameters` path.

### Removed

## [2026.8.12-4] - 2026-08-12

### Breaking Changes

### Added

- Added `retryTransientCall()`, a throw-based sibling of `retryAssistantCall()` that shares the same bounded
  exponential backoff, abort, and retry-callback contract for producers that signal failure by throwing ([#834](https://github.com/code-yeongyu/senpi/pull/834)).

- Added the OpenGateway built-in provider for the OpenAI-compatible gateway at `https://apis.opengateway.ai`: a generated 62-model catalog hydrated from the live `/v1/models` endpoint (chat-capable, non-retired models enriched with models.dev pricing/context/reasoning metadata), `OPENGATEWAY_API_KEY` env detection, and `supportsDeveloperRole: false` compat because the gateway rejects the OpenAI `developer` role. [#832](https://github.com/code-yeongyu/senpi/pull/832)

### Changed

### Fixed

### Removed

## [2026.8.12-3] - 2026-08-12

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.12-2] - 2026-08-12

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.12] - 2026-08-12

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.11-6] - 2026-08-11

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.11-5] - 2026-08-11

### Breaking Changes

### Added

### Changed

- Changed direct Anthropic API prompt caching to use the provider's 5-minute default unless long retention is explicitly selected ([#820](https://github.com/code-yeongyu/senpi/pull/820)).

### Fixed

### Removed

## [2026.8.11-4] - 2026-08-11

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.11-3] - 2026-08-11

### Breaking Changes

### Added

- Added `image_generation_call` reconciliation to the OpenAI Responses shared stream processor: completed
  native image results occupy a single provider-native slot (added then replaced in place on done),
  partial-image events are ignored, oversized payloads are rejected before persistence, and a
  `supportsImageGeneration` compat flag gates server-tool injection per endpoint
  ([#814](https://github.com/code-yeongyu/senpi/pull/814)).
- Added an `openai-images` Images API adapter for text-only OpenAI image generations, with canonical `/v1`
  endpoint normalization, shared credential-header auth, provider-owned retries, usage/cost mapping, and lazy
  builtin registration ([#813](https://github.com/code-yeongyu/senpi/pull/813)).
- Added a built-in `openai` images provider serving generated `gpt-image-2` and `gpt-image-1.5` catalog entries,
  authenticated through `OPENAI_API_KEY` ([#813](https://github.com/code-yeongyu/senpi/pull/813)).

### Changed

### Fixed

- Replayed tool-call IDs are normalized to the strict OpenAI-compatible character and length constraints while
  preserving paired tool results, so Kimi histories containing IDs such as `eval:18` no longer fail when a
  conversation switches to an Anthropic-backed gateway ([#810](https://github.com/code-yeongyu/senpi/pull/810)).
- Gateway/provider failures reported as `The model request was rejected. Check the request and try again.` now go
  through the configured bounded retry policy instead of failing immediately or burning the fallback chain
  ([#806](https://github.com/code-yeongyu/senpi/pull/806)).
- `OAuthAuth` accepts an optional availability `check` that `checkProviderAuth` consults in the stored-OAuth
  branch, so a provider whose stored credential does not by itself imply usability (for example a zero-account
  sentinel) is no longer reported as configured. When `check` is absent, behavior is unchanged
  ([#804](https://github.com/code-yeongyu/senpi/pull/804)).
- Provider-specific OAuth availability checks can now reject empty sentinel credentials and recognize usable ambient
  auth without refreshing or exposing tokens ([#803](https://github.com/code-yeongyu/senpi/pull/803)).

### Removed

## [2026.8.11-2] - 2026-08-10

### Breaking Changes

### Added

- Added `getWireIdentity()` and `setWireIdentity()` for configuring the product token used on outgoing requests, so
  distributions repackaging the engine can supply their own wire identity
  ([#783](https://github.com/code-yeongyu/senpi/pull/783)).

### Changed

### Fixed

### Removed

## [2026.8.11] - 2026-08-10

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.10] - 2026-08-10

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.9-2] - 2026-08-09

### Breaking Changes

### Added

- Added a native Anthropic `warmPromptCache` primitive for zero-output prompt-cache pre-warming with normalized cache usage accounting.
- Added `prompt_cache_key` support for Moonshot/Kimi Chat Completions and first-request OpenRouter affinity through
  both `x-session-id` and the request body's `session_id`.

### Changed

- Expanded explicit OpenRouter prompt-cache markers to Anthropic, Qwen, and Google model prefixes, including
  catalog model IDs with one leading `~`.

### Fixed

- Fixed Kimi cache-read accounting for flat `usage.cached_tokens` responses.
- Restricted Bedrock one-hour prompt-cache TTLs to Claude Opus 4.5, Sonnet 4.5, and Haiku 4.5; other cacheable
  Bedrock Claude models now consistently use the five-minute wire and resolver TTL.
- Reported the Claude SDK OAuth lane's SDK-managed prompt-cache TTL as five minutes.
- Fixed `warmPromptCache` eagerly loading the Anthropic SDK and message implementation for models that cannot use
  Anthropic prompt-cache warming. Capability checks now run first, so unsupported provider lanes avoid the optional
  Anthropic dependency entirely while supported models preserve the same pre-warm request and usage accounting.

- Recovered Claude tool calls that omit the opening `<` before a lowercase
  `antml:invoke` and append a stray `</function_results>` trailer, dispatching
  the validated tool call instead of exposing internal protocol markup.

### Removed

## [2026.8.9] - 2026-08-09

### Breaking Changes

### Added

### Changed

### Fixed

- Added shared assistant-content visibility classification that ignores Unicode format characters before checking
  text, preventing zero-width-only output from being treated as a visible response while preserving emoji ZWJ
  sequences and tool calls.

### Removed

## [2026.8.7] - 2026-08-07

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.6] - 2026-08-06

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.5-2] - 2026-08-05

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.5] - 2026-08-05

### Breaking Changes

### Added

### Changed

### Fixed

- Fixed OpenAI-compatible Chat Completions tool schemas whose object-shaped root used `anyOf`, `oneOf`, or `allOf`:
  root object typing is no longer hoisted away, and object-shaped root `anyOf`/`oneOf` schemas now retain root
  properties and required names while merging branch properties. The same object-root normalization is used for
  Moonshot, while scalar and mixed root unions are left unchanged rather than being mislabeled as objects
  ([#718](https://github.com/code-yeongyu/senpi/pull/718)).
- Fixed Anthropic tool conversion advertising object-shaped root `anyOf`/`oneOf` schemas as parameterless tools.
  The adapter now resolves those schemas into top-level properties and required names before constructing
  `input_schema`, while leaving ordinary object schemas unchanged
  ([#718](https://github.com/code-yeongyu/senpi/pull/718)).
- Stopped same-model retries for recognized malformed `tools.`/`functions.` schema errors, including
  gateway-wrapped 5xx responses and `invalid tool schema` messages. These matches are classified non-retryable before
  generic server-error rules; unrelated transient 5xx failures remain retryable
  ([#718](https://github.com/code-yeongyu/senpi/pull/718)).

### Removed

## [2026.8.4-2] - 2026-08-04

### Breaking Changes

### Added

### Changed

### Fixed

- Fixed strict release-time model regeneration after Groq replaced `qwen/qwen3-32b` with
  `qwen/qwen3.6-27b`: the active multimodal model now receives Groq's documented
  `reasoning_effort` compatibility (`off` to `none`, thinking mode to `default`), the typed request regression
  follows the replacement catalog ID, and reviewed provider snapshots are refreshed so live generation no longer
  breaks root TypeScript validation before a release can be committed
  ([#716](https://github.com/code-yeongyu/senpi/pull/716)).

### Removed

## [2026.8.4] - 2026-08-04

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.3-3] - 2026-08-03

### Breaking Changes

### Added

- Added the official Ollama Cloud provider as an OpenAI-compatible builtin using `OLLAMA_API_KEY` and `https://ollama.com/v1`, discovering tool-capable models through `/api/tags` and `/api/show` with bounded-concurrency inspection, derived thinking/vision/context metadata, and last-known-catalog retention when a refresh fails or returns no usable models ([#525](https://github.com/code-yeongyu/senpi/pull/525) by [@thisisjun786](https://github.com/thisisjun786)).

### Changed

### Fixed

### Removed

## [2026.8.3-2] - 2026-08-03

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.8.3] - 2026-08-03

### Breaking Changes

### Added

- Added strict 429 retry-hint extraction with canonical markers at Anthropic and Codex API boundaries, and propagated structured `retry-after` hints through provider retries ([#657](https://github.com/code-yeongyu/senpi/pull/657)).

### Changed

### Fixed

- Enforced final Anthropic tool-use/tool-result pairing after pruning, interruption, or model switching ([#641](https://github.com/code-yeongyu/senpi/pull/641)).
- Restored non-429 `retry-after` handling displaced during the hint-aware 429 retry migration ([#657](https://github.com/code-yeongyu/senpi/pull/657)).
- Updated GPT-5.6 Terra and Luna pricing across OpenAI and passthrough model catalogs.
- Fixed Fireworks Kimi K3 models to use the OpenAI-compatible API with native reasoning-effort levels and deferred tools ([#7199](https://github.com/earendil-works/pi/issues/7199), [#7230](https://github.com/earendil-works/pi/pull/7230) by [@XBeg9](https://github.com/XBeg9)).

### Removed

## [2026.8.1] - 2026-08-01

### Breaking Changes

### Added

### Changed

- Refresh generated provider catalogs from their live sources. OpenRouter now
  removes 29 no-longer-advertised `:batch` variants plus retired
  `mistralai/devstral-2512` and `openai/gpt-5.1-chat`, and adds
  `thinkingmachines/inkling-small`; Vercel AI Gateway adds
  `deepseek/deepseek-v4-flash-0731`; Z.AI and Z.AI Coding CN replace
  `glm-4.5-air`, `glm-5.1`, and `glm-5v-turbo` with
  `glm-5.2-highspeed[1m]`. Static provider tests now use the still-published
  `glm-4.7` fixture or explicit compatibility overrides, and Z.AI defaults now
  resolve to `glm-5.2`, so future catalog removals cannot leave release-time
  type checking or default selection silently stale.

### Fixed

- Make explicit reasoning capability metadata authoritative across model
  discovery and request construction: a present `thinkingLevelMap` now
  supports only the listed levels, `null` remains an explicit veto, and
  model-ID inference applies only to map-less models. This prevents the CLI
  and provider payload from advertising `xhigh` or `max` when catalog metadata
  intentionally omits them
  ([#586](https://github.com/code-yeongyu/senpi/pull/586) by
  [@realsigridjin](https://github.com/realsigridjin)).

- Align Codex SSE and WebSocket prompt-cache affinity with the official client
  by sending one stable session tuple across `prompt_cache_key`, `session-id`,
  `thread-id`, and `x-client-request-id`. The no-affinity SSE boundary for
  `cacheRetention: "none"` remains unchanged, while ordinary sessions avoid
  repeatedly re-uploading large uncached prefixes
  ([#597](https://github.com/code-yeongyu/senpi/pull/597)).

- Recover Codex WebSocket sessions after transient transport degradation.
  Immediate follow-up requests stay on SSE during a 60-second cooldown, the
  next fresh request may probe WebSocket again, production cleanup clears the
  degraded-route state, and the existing post-start billing guard still
  prevents replaying a response that may already have started
  ([#600](https://github.com/code-yeongyu/senpi/pull/600)).

### Removed

## [2026.7.31-2] - 2026-07-31

### Breaking Changes

### Added

- Expose `StreamOptions.streamKind` so provider implementations can distinguish the primary agent loop from
  auxiliary compaction, title-generation, and helper requests. Main-loop callers opt in explicitly; an absent value
  remains auxiliary so providers fail safe instead of accidentally retaining one-shot work in a resident session.

- Support `max` reasoning for map-less GPT-5.6 Sol models across OpenAI Responses, Azure OpenAI Responses, Codex
  Responses, and OpenAI Completions. Explicit `thinkingLevelMap` values remain authoritative: a missing level on a
  present map stays unavailable, and `null` continues to veto model-ID capability detection.

### Changed

### Fixed

- Serialize unavailable Anthropic tool history into non-imitable XML-style records that omit historical call inputs,
  neutralize case-variant result envelopes, and retain only safe result context plus guidance derived from the tools
  that are actually available on the current request.

### Removed

## [2026.7.31] - 2026-07-31

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.30-2] - 2026-07-30

### Breaking Changes

### Added

### Changed

### Fixed

- Recover Kimi-family visible response channels that arrive inside structural XTML thinking streams. Text is
  promoted only after an explicit response-open boundary, while structural markers are sanitized without exposing
  closing-marker-only chain-of-thought. Harden recovery to strip malformed unnamed channels, `tools` and other valid
  named channels, and bare XTML open / close / separator tokens, including markers split across stream chunks.
  Recovery preserves XTML-looking inline and fenced code, runs even when no tools are registered, and remains
  isolated to Kimi-family models
  ([#523](https://github.com/code-yeongyu/senpi/pull/523),
  [#537](https://github.com/code-yeongyu/senpi/pull/537)).

### Removed

## [2026.7.30] - 2026-07-30

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29-6] - 2026-07-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29-5] - 2026-07-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29-4] - 2026-07-29

### Breaking Changes

### Added

### Changed

### Fixed

- Preserve Kimi XTML protocol identity in recovered tool-call diagnostics and IDs, and serialize OpenAI-compatible
  reasoning, text, and native tool-call lifecycles without breaking providers that stream mixed content and
  parallel tool deltas ([#498](https://github.com/code-yeongyu/senpi/pull/498)).

### Removed

## [2026.7.29-3] - 2026-07-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29-2] - 2026-07-29

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.29] - 2026-07-29

### Breaking Changes

### Added

- Added the native `kimi-xtml` text tool-call protocol for Kimi K3, including typed argument coercion, chunk-safe streaming, incomplete-call finalization, and normal-mode recovery that turns leaked XTML channel blocks into executable tool calls while removing protocol markers from visible assistant text ([#465](https://github.com/code-yeongyu/senpi/pull/465)).

### Changed

### Fixed

- Treat Anthropic `credits_required` and “credits are required” responses as non-retryable billing failures, avoiding repeated requests against an exhausted account and allowing the coding agent to pin a configured fallback immediately ([#484](https://github.com/code-yeongyu/senpi/pull/484)).
- Classify zero-event provider-stream stalls separately from ordinary transient failures so the coding agent can apply bounded stall escalation instead of replaying a dead upstream with the full idle timeout on every retry ([#453](https://github.com/code-yeongyu/senpi/pull/453)).
- Preserve steering and follow-up input across provider idle-timeout retries, cap only the retry continuation’s idle wait at 30 seconds, and restore the configured timeout for later ordinary turns ([#458](https://github.com/code-yeongyu/senpi/pull/458) by [@realsigridjin](https://github.com/realsigridjin)).
- Treat provider configurations whose authentication is fully supplied through custom headers as configured, while leaving `authHeader` and genuinely unauthenticated configurations unchanged ([#472](https://github.com/code-yeongyu/senpi/pull/472) by [@eddieparc](https://github.com/eddieparc)).
- Abort provider requests that emit no first stream event within the new stream-start timeout, producing a retryable diagnostic and tearing down the dead request without waiting for the longer in-stream idle timeout ([#451](https://github.com/code-yeongyu/senpi/pull/451)).

### Removed

## [2026.7.28-3] - 2026-07-28

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.28-2] - 2026-07-28

### Breaking Changes

### Added

### Changed

### Fixed

- Preserve Anthropic request integrity when conversation history contains tool-result references whose original tool-use blocks are no longer available: orphaned references are demoted to ordinary text instead of sending an invalid payload that Anthropic rejects ([#437](https://github.com/code-yeongyu/senpi/pull/437)).

### Removed

## [2026.7.28] - 2026-07-28

### Breaking Changes

### Added

- Add OpenAI `-fast` catalog variants that request priority service tier while preserving the upstream model identity ([#420](https://github.com/code-yeongyu/senpi/pull/420)).

### Changed

- Retry provider streams that fail before producing output, preserving callback ordering and allowing the normal bounded fallback policy to recover ([#421](https://github.com/code-yeongyu/senpi/pull/421)).

### Fixed

- Retry Cloudflare 522 connection-timeout responses as transient provider failures ([#404](https://github.com/code-yeongyu/senpi/pull/404)).
- Normalize legacy Codex reasoning-summary settings and omit unsupported summary values that caused OpenAI Responses and compaction requests to fail ([#412](https://github.com/code-yeongyu/senpi/pull/412) by [@DevNewbie1826](https://github.com/DevNewbie1826), [#416](https://github.com/code-yeongyu/senpi/pull/416)).
- Honor explicitly disabled Azure prompt caching instead of re-enabling it during request construction.

### Removed

## [2026.7.26] - 2026-07-26

### Breaking Changes

### Added

### Changed

- Retry transient Codex `upstream_unavailable` websocket failures through the existing bounded retry policy ([#330](https://github.com/code-yeongyu/senpi/pull/330) by [@minpeter](https://github.com/minpeter)).

### Fixed

- Preserve persisted OpenAI Responses freeform custom-tool calls and raw inputs across compaction and model replay without emitting synthetic item IDs ([#256](https://github.com/code-yeongyu/senpi/pull/256) by [@ThewindMom](https://github.com/ThewindMom)).
- Repair incomplete Anthropic server-tool histories before replay and allow pairing failures to reach retry and configured model fallback.
- Harden cross-model history replay against foreign reasoning signatures, colliding long tool-call IDs, and Anthropic thinking-shape requirements ([#380](https://github.com/code-yeongyu/senpi/pull/380) by [@realsigridjin](https://github.com/realsigridjin)).
- Treat typed and legacy Anthropic policy blocks as classifier refusals so partial tool calls are not executed and pinned fallback can engage.

### Removed

## [2026.7.25-2] - 2026-07-25

### Breaking Changes

## [0.83.0] - 2026-07-29

### Breaking Changes

- Upgraded the exported TypeBox dependency to 1.3.7, removing deprecated APIs including `Type.Base`, `Type.Awaited`, `Type.Promise`, `Type.AsyncIterator`, `Type.Iterator`, `Type.Options`, and `Value.Mutate`, while fixing compiled validation of nullable array tool arguments. Consumers using removed APIs must migrate to supported TypeBox APIs ([#7243](https://github.com/earendil-works/pi/pull/7243) by [@petrroll](https://github.com/petrroll)).

### Added

- Added per-request `fetch` injection for supported text and image provider transports; Google adapters reject non-global implementations rather than silently bypassing them.
- Added Claude Opus 5 support for the GitHub Copilot provider, routing through the Anthropic Messages API with adaptive thinking, 1M context, and the Copilot `minimal` thinking-level override ([#7158](https://github.com/earendil-works/pi/pull/7158) by [@jay-aye-see-kay](https://github.com/jay-aye-see-kay)).
- Added the `"pending"` stop reason for partial streaming messages. See [Stop Reasons](README.md#stop-reasons) ([#7151](https://github.com/earendil-works/pi/pull/7151) by [@lucasmeijer](https://github.com/lucasmeijer)).
- Added `AssistantMessage.rawStopReason` and populated it across Google, Anthropic, Amazon Bedrock, Mistral, and OpenAI streams; unmapped terminal reasons now surface as provider errors instead of successful stops ([#7272](https://github.com/earendil-works/pi/pull/7272)).
- Added manual redirect URL and authorization-code entry to OpenRouter OAuth login for remote and headless environments ([#7114](https://github.com/earendil-works/pi/pull/7114) by [@rgarcia](https://github.com/rgarcia)).
- Added `AuthResolutionOverrides.minOAuthValidityMs` so callers can require and refresh OAuth credentials with a minimum remaining validity ([#7168](https://github.com/earendil-works/pi/pull/7168)).

### Changed

- Changed stored OAuth credentials to refresh when less than five minutes of validity remain instead of waiting until expiration ([#7168](https://github.com/earendil-works/pi/pull/7168)).

### Fixed

- Fixed Qwen Token Plan reasoning models to send their service-specific thinking controls and supported reasoning-effort levels ([#6951](https://github.com/earendil-works/pi/issues/6951), [#6998](https://github.com/earendil-works/pi/issues/6998)).
- Fixed Z.AI providers and compatible custom endpoints to send output limits through `max_tokens`, which those endpoints honor ([#7174](https://github.com/earendil-works/pi/pull/7174) by [@HyeokjaeLee](https://github.com/HyeokjaeLee)).
- Fixed explicitly configured Amazon Bedrock profiles being overridden by ambient AWS access keys ([#7176](https://github.com/earendil-works/pi/pull/7176) by [@christianbasch](https://github.com/christianbasch)).
- Fixed malformed OpenAI-compatible tool-call deltas with both a valid `function` payload and an empty `custom` object discarding the function arguments ([#7288](https://github.com/earendil-works/pi/pull/7288) by [@sunnyyoung](https://github.com/sunnyyoung)).

## [0.82.1] - 2026-07-25

### Added

- Added `ModelsStoreEntry.etag` so persisted provider catalogs can carry the remote ETag validator for conditional refreshes.
- Added Claude Opus 5 support for Anthropic and Amazon Bedrock with adaptive thinking, inference profiles, prompt caching, and preserved AWS validation messages ([#7081](https://github.com/earendil-works/pi/pull/7081) by [@unexge](https://github.com/unexge), [#7083](https://github.com/earendil-works/pi/pull/7083) by [@davidbrai](https://github.com/davidbrai)).

### Changed

- Changed Radius OAuth device authorization, token exchange, and refresh requests to use the configured gateway directly.
- Changed `ModelsError` messages to append the underlying cause, so auth failures such as `OAuth refresh failed for openai-codex` report the provider response instead of a bare wrapper message.

### Fixed

### Removed

## [2026.7.25] - 2026-07-25

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [2026.7.24] - 2026-07-24

### Breaking Changes

### Added

- Added `ANTHROPIC_AUTH_TOKEN` bearer authentication for Anthropic-compatible gateways ([#5871](https://github.com/earendil-works/pi/issues/5871))

### Changed

### Fixed

- Updated e2e and xhigh reasoning tests to use `gpt-5.3-codex` after the regenerated model catalog rotated out `gpt-5.2-codex` and `gpt-5.1-codex-max` from the `openai` provider.

### Removed

## [0.82.0] - 2026-07-24

### Breaking Changes


[Showing lines 1-1075 of 3194 (50.0KB limit). Use offset=1076 to continue.]