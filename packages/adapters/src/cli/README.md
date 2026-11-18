# CLI adapters (P0)

Implement `SessionAdapter` (`@portage/core`) for Codex / Claude Code CLI first.

Expected capabilities for MVP:

```ts
{
  discover: true,
  read: true,
  write: true,
  idleSignal: true,
  tail: true,
  createSession: false
}
```

Wire:

1. Discovery via process / pane registry → Session + NativeBinding + Endpoint
2. Ready via vendor turn-end / idle hooks
3. Inject compiled query into the live CLI session (with proof levels)
4. Register MCP tools against Portage Bus API

Do not invent room job roles. Collaboration MD is constraints only.
