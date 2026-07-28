# bash-timeout builtin extension — fork surface

Injects the default `timeout` into every `bash` call and appends the "Bash Tool Timeout Policy"
section to the system prompt.

## Cache-aware ceiling and native-Anthropic-bash exception (2026-07-28)

### What changed

- `timeout.ts`: `resolveEffectiveBashTimeouts(defaults, safeWaitSeconds)` lowers the recommended
  maximum to the prompt-cache safe-wait budget (`ExtensionContext.getPromptCacheSafeWaitSeconds()`),
  pulling the injected default down with it when the budget is smaller. `buildBashTimeoutPrompt`
  names the ceiling, the prompt-cache reason, and steers cleanup through `kill_bash`.
- `index.ts`: the policy prompt is rebuilt per `before_agent_start` from the LIVE model, and the
  budget is suppressed when native Anthropic bash is active for an `anthropic-messages` model.

### Why the native-Anthropic-bash exception exists

When `PI_ANTHROPIC_BASH` is enabled the provider replaces the PTY `bash` tool and the `terminal`
extension steps aside (`terminal/extension.ts` `shouldStepAside`). Nothing then implements the
cache-deadline auto-detach, so advertising a cache ceiling would promise behavior that cannot
happen. The budget therefore only applies while the PTY tool is live.

### Behavior when no budget applies

Byte-identical to the pre-change policy: the same injected default, the same recommended maximum,
and a prompt string that compares equal under strict `===`.
