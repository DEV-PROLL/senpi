# OpenAI Codex usage status

This extension publishes the remaining five-hour and weekly OpenAI Codex limits through `ctx.ui.setStatus()`. It works with Senpi's built-in footer and any custom footer that renders extension statuses.

The extension is best-effort:

- It uses ChatGPT's internal `https://chatgpt.com/backend-api/wham/usage` endpoint, which is not a public API and may change or disappear.
- It runs only for an `openai-codex` model using OAuth credentials with a ChatGPT account ID.
- It refreshes immediately and once per minute while enabled.
- It sends the resolved OAuth bearer token and ChatGPT account ID only to `https://chatgpt.com`; redirects are rejected.
- `/usage` toggles publication without changing the active footer.
