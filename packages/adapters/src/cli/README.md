# CLI process adapters

Sessions that are reached through a running CLI process rather than a native turn.

- `process-discovery.ts` lists live Codex / Claude Code CLI processes (`ps`, ancestor chains for the MCP bridge) and turns them into endpoints with native identity `pid-<pid>`. Exiting (zombie) processes and desktop / app-server / MCP child processes are skipped.
- `file-inbox-adapter.ts` is the default adapter for sessions without `adapterId`: it writes the compiled query to `~/.portage/inbox/<provider>/<nativeIdentity>/`, proves `submitted` by the written file, and `verify` answers present / absent / unknown by content hash for `uncertain` deliveries. The agent reads its inbox through the MCP bridge, which records `agent_ack`.

Sessions that can be resumed headlessly (Codex `exec resume`, Claude Code `-p --resume`) use the native turn adapter in [`../native`](../native) instead: transcript discovery, readiness, submission with policy inheritance, and transcript read-back.

Collaboration MD is constraints only; adapters never add room job roles.
