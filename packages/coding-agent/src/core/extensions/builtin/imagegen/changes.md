# imagegen builtin — changes

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
