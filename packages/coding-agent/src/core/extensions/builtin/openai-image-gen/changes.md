# openai-image-gen builtin — changes

## Native image_generation injection with arbitration (2026-08-11)

### What changed

- Added the `openai-image-gen` builtin. It injects the OpenAI Responses `image_generation` server tool into provider request payloads and arbitrates it against the sibling imagegen builtin's client-side `generate_image` function tool so exactly one surface is exposed per request.
- `gate.ts` exports the pure `supportsNativeOpenAiImageGeneration(model)` gate plus the `PI_OPENAI_IMAGE_GEN` enable-env parse (default-on, mirroring `openai-web-search`) and the `nativeImageGenModelKey` cache key (`provider|api|baseUrl|id`).
- `inject.ts` enforces mutual exclusion at the wire level: native entries are always stripped first, the client function tool is matched by `tool.name === "generate_image"` (faux/extension payloads may omit `type`), and exactly one `{ type: "image_generation" }` is appended in native mode. A no-op returns the ORIGINAL payload reference because payload hooks chain replacements.
- `index.ts` owns the arbitration state machine `{ kind: "native" | "client" | "unavailable", modelKey, source?, reason? }`: refreshed on `session_start` (ctx.model) and `model_select` (event.model), and refreshed inside `before_provider_request` whenever the observed request model's key differs from the cached one. `before_agent_start` appends a short native section only while native-active.
- Cross-builtin wiring per the websearch precedent: this builtin imports `resolveImageGenAuth` and the registry-override seam from `imagegen`, and calls `setNativeBypass` in `imagegen/state.ts` on every refresh (both flip directions), so the client tool defers only while the server tool will actually be injected for the current model. `session_shutdown` clears the bypass.
- Registered the factory in the builtin catalog immediately after `imagegen`.

### Why

- The client tool and the server tool must never be offered together: the model would pick one arbitrarily and the other path's result handling would never run. Arbitration happens at the payload layer, never via `setActiveTools`, so tool registration stays stable for renderers and permissions.
- Divergence from the websearch gate: `azure-openai-responses` defaults to FALSE here. Azure serves image generation as a separate deployment, not as a Responses server tool, so azure endpoints opt in only through an explicit `compat.supportsImageGeneration`. Proxied `openai-responses` endpoints keep the websearch lesson and default to the client tool, because a translating gateway rejects tool types it never implemented.
- The in-hook model-key refresh exists because payload hooks observe the effective request model, which can differ from the last lifecycle-cached model (fallback routing, per-request resolution); a stale decision must never reach the wire.

### Why not core

- Image-surface arbitration is builtin policy. Core owns payload hook chaining and model lifecycle events; the imagegen/openai-image-gen pair owns which image tool a given model may see.

### Test seam note

- `test/suite/generate-image-extension.test.ts` drives both builtins through the real session harness: model switches go through `session.setModel`, payload capture goes through `ExtensionRunner.emitBeforeProviderRequest` (whose optional request-model argument exercises the in-hook staleness refresh), and the credential direction is forced with `setImageGenRegistry` because the ambient builtin catalog is never credential-free.

### Merge-conflict zones

- LOW: `gate.ts`, `inject.ts`, `index.ts`, and this file are new isolated modules owned by this change.
- MEDIUM: `builtin/index.ts` is a shared catalog; preserve sibling registrations and the ordering comment when resolving conflicts.
- MEDIUM: `imagegen/state.ts` and `imagegen/auth.ts` are imported cross-builtin; keep their exported seams (`setNativeBypass`, `imageGenRegistryOverride`, `resolveImageGenAuth`) signature-stable.
