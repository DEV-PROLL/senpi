# changes

## Protocol compatibility fields (2026-08-13)

### What changed

- Preserved video-modality allowance in protocol exact-key checks.
- Preserved tool-call `incomplete` and `errorMessage` fields alongside upstream
  deferred assistant-message support.

### Why

- Senpi transports incomplete tool-call recovery metadata and video-aware
  messages across the server protocol boundary.

### Why an extension could not handle it

- These are transport schema keys validated before server consumers or
  extensions receive the decoded messages.

### Expected merge conflict zones

- MEDIUM: `src/protocol.ts`, in `ExactKeys` manifests and assistant/tool-call
  conversion switches.
