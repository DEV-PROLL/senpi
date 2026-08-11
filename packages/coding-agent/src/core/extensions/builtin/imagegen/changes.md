# imagegen builtin — changes

## generate_image tool (2026-08-11)

### What changed

- Added `tool.ts` exporting `generateImageTool` (`generate_image`) plus `GENERATE_IMAGE_TOOL_NAME` and the `GenerateImageDetails` result shape. The tool is registered once and gated at call time: every execute re-resolves credentials through `resolveImageGenAuth`, so a mid-session login takes effect without a reload.
- Parameters are locked to `prompt` (1–32000 chars, blank-after-trim rejected), `size`/`quality` (`auto` unions), `n` (1–10), and an optional `output_path`, with `additionalProperties: false`. There is intentionally no `model`, `output_format`, or image-input/edit/mask surface in v1; the model is fixed to `gpt-image-2`.
- Output-path handling lives in `paths.ts`: relative paths resolve against `ctx.cwd`, an omitted path falls back to `generated-images/<sanitized tool call id>.png`, extensionless paths gain `.png`, non-`.png` extensions are rejected, and multi-image runs insert a zero-padded index before the extension. Parents are created with `mkdir -p`, existing files are never overwritten (preflight plus exclusive `wx` create), and a partial multi-image write rolls back the files that invocation already wrote.
- Results carry a text summary of saved paths, one image block per image, structured `details` (paths, model, credential `source`, size, quality, requested/generated counts, revised prompts), and provider usage when present. Key material never appears in results or logs.
- Added `state.ts` with the `native_bypass` seam (`setNativeBypass`/`isNativeBypass`, default false) that the sibling `openai-image-gen` builtin will wire live in PR-B, plus a `setImageGenRegistry` override used to force a credential direction in tests.

### Why

- The client tool must work on any OpenAI-compatible credential (native key or gateway) without a session restart, so availability is decided at execute time rather than at registration.
- Synthesizing the `gpt-image-2` image model per resolution keeps the gateway base URL and its key same-source, and threads the key through request options rather than the environment.

### Why not core

- Prompt validation, output-path policy, and file persistence are builtin behavior. Core continues to own credential interpolation; packages/ai stays browser-safe and owns no disk IO.

### Test seam note

- The builtin provider catalog always contains credential-resolvable gateways (for example github-copilot authenticates with static headers and no API key), so the ambient session registry is never credential-free. The uncredentialed direction is exercised through `setImageGenRegistry` with an empty registry rather than by mutating ambient auth.

### Merge-conflict zones

- LOW: `tool.ts`, `paths.ts`, and `state.ts` are new isolated modules; `index.ts` (the extension entry that wires them) is owned by the skill-packaging todo.
- MEDIUM: this `changes.md` receives entries from the resolver, tool, skill-gating, and native-injector lanes; preserve all dated sections when resolving concurrent additions.

## Credential-gate resolver (2026-08-11)

### What changed

- Added `auth.ts` with the pure `resolveImageGenAuth` resolver. It resolves, in order: a stored OpenAI API key, an explicitly pinned OpenAI-compatible gateway, the preferred configured gateway (`/openai/i` provider ids first, then alphabetical), and `OPENAI_API_KEY`.
- Gateway credentials resolve through the injected `ModelRegistry` surface (`getAll` plus `getApiKeyAndHeaders`) so models.json/provider auth keeps its existing environment, command, custom-header, and `authHeader` semantics. The resolver never reads `models.json` or `auth.json` directly.
- Provider model catalogs only supply a registry route for credential resolution; no image model must be listed because the client tool synthesizes the fixed `gpt-image-2` image model.

### Why

- The client tool, conditional skill, and native OpenAI injector need one credential predicate with identical precedence and fallback behavior. Centralizing it prevents a tool from appearing active while another consumer believes image generation is unavailable.
- Credentials remain same-source with their gateway base URL, so an OpenAI key cannot be combined with a third-party endpoint during fallback.

### Why not core

- Image-generation route policy, provider preference, and setup guidance are builtin behavior. Core `ModelRegistry` and auth storage remain provider-agnostic and continue owning credential interpolation and header materialization.

### Cross-builtin export intent

- `resolveImageGenAuth` is intentionally exported from `imagegen/auth.ts` for the imagegen tool/skill and the sibling `openai-image-gen` builtin. Keep the resolver pure and registry-shaped rather than moving policy into either consumer.

### Reload granularity

- Skill resources refresh at startup or explicit reload. Client-tool availability snapshots refresh at session start/model select, while every tool execution re-resolves credentials. Native injection resolves per provider request. This difference is accepted; conditional skill text must remain safe when credentials change before reload.

### Merge-conflict zones

- LOW: `auth.ts` is a new isolated module.
- MEDIUM: this `changes.md` will receive entries from the tool, skill-gating, and native-injector lanes; preserve all dated sections when resolving concurrent additions.
- NONE: this change does not edit `imagegen/skill/`, builtin registration, or packages/ai files.

## Credential-gate resolver tightening (2026-08-11)

### What changed

- `credentialParts` now requires a non-empty `apiKey`; headers alone no longer qualify a provider as an image-gen credential source.
- Headers are still threaded through when a key exists.

### Why

- Providers like `github-copilot` resolve `ok:true` with static headers and no apiKey. Those headers authenticate only their own endpoint; calling `/images/generations` there would fail confusingly. The gateway scan and `PI_IMAGE_GEN_PROVIDER` pin must require a real apiKey.

### Merge-conflict zones

- LOW: one-line guard change in `auth.ts`.
- NONE: no other modules touched.
