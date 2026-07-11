# ADR-0010 — MCP Streamable-HTTP transport and sidetrack.* namespace

- Status: Accepted (retroactive, 2026-07-11)
- Date: 2026-07-11
- Owner: User + Claude
- Components: MCP | API | Shared
- Related: ADR-0001, ADR-0004, PRD §6.2.6

## Context

The `sidetrack-mcp` package (`packages/sidetrack-mcp/`) exposes the
Sidetrack vault state to coding agents (Claude Code, Cursor, Codex,
etc.) via the MCP protocol. Two transport modes and a namespace
decision required recording:

**Transport modes**:
- `stdio` — the default. Coding-agent MCP configuration launches
  `sidetrack-mcp --vault <path>` as a subprocess and communicates
  over stdin/stdout using the MCP SDK's `StdioServerTransport`.
  No authentication needed; the subprocess is owned by the agent.
- `streamable-http` — for long-lived local-agent integration.
  The server listens on `127.0.0.1:8721/mcp` (default) using the
  MCP SDK's `StreamableHTTPServerTransport`. Every request must
  include `Authorization: Bearer <key>` where the key is read from
  `<vault>/_BAC/.config/bridge.key`. The PRD originally described
  this route as a raw WebSocket at `ws://127.0.0.1:8721/mcp`; the
  shipped implementation uses HTTP, not WebSocket.

**Namespace**:
- The original PRD described tools in the `bac.*` namespace
  (e.g. `bac.recall`, `bac.context_pack`). The shipped implementation
  uses `sidetrack.*` (e.g. `sidetrack.recall.query`,
  `sidetrack.workstreams.context_pack`). See the tool list in
  `packages/sidetrack-mcp/src/capabilities.ts`.

**Auth model for streamable-HTTP**:
`startStreamableHttpMcpServer` (in
`packages/sidetrack-mcp/src/server/streamableHttpServer.ts`) requires
a non-empty `authKey` parameter and rejects requests whose
`Authorization: Bearer` header does not match. The constant
`sidetrackMcpHttpPort = 8721` and path `sidetrackMcpHttpPath = '/mcp'`
are the canonical defaults.

## Decision

1. **Default transport is stdio**. Streamable-HTTP is opt-in via
   `--transport streamable-http`.
2. **Streamable-HTTP port is 8721, path is `/mcp`, auth is mandatory**.
   The server refuses to start without a non-empty auth key.
3. **Tool namespace is `sidetrack.*`**. The original `bac.*` namespace
   is deprecated; any client configuration using `bac.*` must be
   updated.
4. **The companion write tools** (`sidetrack.dispatch.create`,
   `sidetrack.threads.move`, `sidetrack.queue.create`,
   `sidetrack.session.attach`, `sidetrack.workstreams.bump`, etc.) are
   enabled by passing `--companion-url <url> --bridge-key <key>` to
   the MCP server. Without these flags, the server is read-only.

## Options considered

### Option A — Raw WebSocket transport (original PRD)

Pros:
- WebSocket allows server-initiated push (for future live-update use
  cases).

Cons:
- The MCP SDK's `StreamableHTTPServerTransport` is the idiomatic
  transport for long-lived local connections in MCP 2025.
- Raw WebSocket is not MCP-native; it would require a custom framing
  layer.
- HTTP is simpler to debug (`curl`, Postman, standard HTTP tools).

### Option B — MCP Streamable-HTTP (chosen)

Pros:
- Uses the MCP SDK's own transport; SDK upgrades are free.
- Compatible with any MCP client that supports streamable-HTTP.
- `curl -H 'Authorization: Bearer <key>'` works for ad-hoc testing.
- Consistent with the companion's own HTTP loopback design (ADR-0001).

Cons:
- No server-push capability (not needed for current read/write tools).
- Clients must be configured to use `http://` not `ws://` URL.

### Option C — stdio only (no persistent server mode)

Pros:
- Simplest; no port to manage.

Cons:
- Coding agents that need a long-lived session (e.g. a background
  agent that re-queries without re-launching the subprocess) would
  pay subprocess-startup overhead on every query.
- Does not support multi-client scenarios (one MCP server instance
  serving multiple coding agents simultaneously).

## Consequences

Positive:
- Coding agents using stdio get zero-config access: one line in their
  MCP config, no key management.
- Long-lived agents using streamable-HTTP share one server process.
- The MCP SDK manages session lifecycle and transport framing.
- Auth is enforced at the transport level; no per-tool auth needed.

Negative:
- Clients that configured `bac.*` tool names must be updated to
  `sidetrack.*`.
- Port 8721 must be available. If another process binds it, the user
  must pass `--port <other>`.
- `--companion-url` and `--bridge-key` must be supplied together
  (validated in `cli.ts`); missing one is an error.

## Extension model

New MCP tools are added to `mcpServer.ts` and registered in
`capabilities.ts`. Tool names follow the `sidetrack.<domain>.<action>`
convention (e.g. `sidetrack.workstreams.context_pack`). New read-only
tools do not require companion-write-client credentials. New write
tools require `--companion-url` + `--bridge-key`.

## Security and operations impact

The streamable-HTTP transport binds `127.0.0.1` only (loopback; not
`0.0.0.0`). The auth key is at `_BAC/.config/bridge.key` (mode 600,
companion-generated). The server validates the key with a constant-time
compare. No remote services are contacted. Audit log for every tool
call goes to `_BAC/audit/<date>.jsonl` when the companion write client
is present.
