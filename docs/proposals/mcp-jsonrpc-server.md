# Proposal: JSON-RPC MCP server in the Sidetrack companion

> Status: Shipped — `packages/sidetrack-mcp` now provides the local
> WebSocket JSON-RPC endpoint. Companion-embedded bootstrap remains a
> follow-up.
> Audience: the next coder who picks this up.
> Author: drafted alongside the inline-review and coding-agent handoff
> work in the M1+M2 push (see `BRAINSTORM-INDEX.md` §24.5).

## Why

Today the companion exposes a tool surface as **HTTP routes with two
custom headers** — `x-bac-bridge-key` for auth and
`x-sidetrack-mcp-tool` to pick the tool. The handlers live in
`packages/sidetrack-companion/src/http/server.ts` and each tool is
documented under `docs/mcp/bac.*.md`.

That surface works for any agent that speaks HTTP-with-headers, but
it isn't the **MCP** protocol. Coding agents that integrate against a
real MCP server (Claude Code, Cursor, etc.) can't connect to it. The
v2 design (`switchboard/project/surfaces/mcp.jsx`) envisions the
companion shipping a proper MCP server alongside the existing HTTP:

- endpoint: `ws://127.0.0.1:8721/mcp`
- transport: WebSocket, with a Streamable-HTTP fallback
- auth: bearer (the existing bridge key)

This proposal scopes that server. It does NOT remove or replace the
existing HTTP surface — both run side by side.

## Goal

Expose the same read-only tool surface over JSON-RPC so any
spec-compliant MCP client (Claude Code, Cursor, Windsurf, generic
`@modelcontextprotocol/sdk` clients) can connect to a running
Sidetrack companion and read thread / dispatch / workstream data.

## Out of scope

- **Write tools** (`bac.append_decision`, `bac.dispatch`,
  `bac.create_annotation`). Defer to v1.5 — read-only first.
- **Multi-vault routing**. The MCP server runs against the
  companion's currently-bound vault. Vault switching stays a
  side-panel concern.
- **Replacing the HTTP+headers route** in `src/http/server.ts`. The
  side panel and the existing extension content scripts continue to
  use HTTP. The MCP server is additive for external agents.

## Tools to expose (v1)

Read-only. Each tool delegates to the existing handler logic in
`src/http/server.ts` so the response shape stays identical.

| MCP tool name               | Backed by HTTP route                      | Doc                                     |
| --------------------------- | ----------------------------------------- | --------------------------------------- |
| `bac.recall`                | `POST /v1/recall`                         | `docs/mcp/bac.recall.md`                |
| `bac.read_thread_md`        | `GET /v1/threads/{id}.md`                 | `docs/mcp/bac.read_thread_md.md`        |
| `bac.read_workstream_md`    | `GET /v1/workstreams/{id}.md`             | `docs/mcp/bac.read_workstream_md.md`    |
| `bac.list_dispatches`       | `GET /v1/dispatch-events` (+ tool header) | `docs/mcp/bac.list_dispatches.md`       |
| `bac.list_workstream_notes` | `GET /v1/workstream-notes`                | `docs/mcp/bac.list_workstream_notes.md` |
| `bac.list_buckets`          | `GET /v1/buckets`                         | `docs/mcp/bac.list_buckets.md`          |
| `bac.list_audit_events`     | `GET /v1/audit-events`                    | `docs/mcp/bac.list_audit_events.md`     |
| `bac.create_annotation`     | `POST /v1/annotations`                    | `docs/mcp/bac.create_annotation.md`     |
| `bac.list_annotations`      | `GET /v1/annotations`                     | `docs/mcp/bac.list_annotations.md`      |
| `bac.system_health`         | `GET /v1/health`                          | `docs/mcp/bac.system_health.md`         |
| `bac.archive_thread`        | `POST /v1/threads/{id}/archive`           | `docs/mcp/bac.archive_thread.md`        |
| `bac.unarchive_thread`      | `POST /v1/threads/{id}/unarchive`         | `docs/mcp/bac.unarchive_thread.md`      |
| `bac.suggest_workstream`    | `POST /v1/suggest-workstream`             | `docs/mcp/bac.suggest_workstream.md`    |
| `bac.bump_workstream`       | `POST /v1/workstreams/{id}/bump`          | `docs/mcp/bac.bump_workstream.md`       |

Plus one new tool that the v2 design names but hasn't been built:

- `bac.context_pack` — return a portable handoff bundle as a single
  zip blob. Inputs: `threadId` (required), `includeWorkstream`
  (default true), `includeDispatches` (default true). Output: zip
  with `thread.md`, `workstream.md`, `dispatches.md`, and an
  `index.json` summarizing what's inside. Useful for offline coding
  agents that don't speak MCP either — the user picks "Send to
  coding agent" with the **bundle** copy mode and pastes a path to
  the zip into their agent.

## Architecture

```
sidetrack-companion/src/
├── http/
│   ├── server.ts          # existing HTTP+header surface (unchanged)
│   └── ...
├── mcp/                   # NEW
│   ├── server.ts          # JSON-RPC server bootstrap + transport
│   ├── tools.ts           # tool registration + dispatch
│   ├── transport/
│   │   ├── stdio.ts       # for Claude Code (spawned as a child)
│   │   ├── websocket.ts   # for Cursor / Windsurf (long-lived)
│   │   └── http.ts        # Streamable-HTTP fallback per MCP spec
│   ├── handlers/          # one file per tool, each calling the
│   │   ├── recall.ts      # existing service-layer helpers
│   │   ├── read_thread.ts
│   │   └── ...
│   └── auth.ts            # bearer-key check (reuses bridge key)
└── runtime/
    └── start.ts           # boots HTTP + MCP servers together
```

Implementation pointers:

- Use the official SDK: `@modelcontextprotocol/sdk` (npm). It
  provides the protocol envelope (`InitializeRequest`, `tools/list`,
  `tools/call`, error mapping).
- Keep `tools.ts` declarative — each tool entry has a JSON schema
  for inputs, an output schema, and a handler function. The schema
  doubles as docs that the MCP client surfaces in its UI.
- Each handler MUST call into the same service-layer code that the
  HTTP route calls (e.g. `vault/reader.ts`, `recall/index.ts`). Do
  not duplicate logic; the HTTP server keeps working unchanged.

## Auth

Same bridge key as HTTP. On the WebSocket transport, accept it via:

1. `Sec-WebSocket-Protocol: bearer.<bridge-key>` (preferred — keeps
   the key out of URLs and request logs), or
2. `?token=<bridge-key>` query param (fallback for clients that
   can't set custom subprotocols).

On stdio transport, the companion can spawn a child wrapper that
already shares a process boundary with the user's shell — the bridge
key is read from the same vault file the existing companion reads
(`{vault}/_BAC/.config/bridge.key`).

Reject anything else with the JSON-RPC error code `-32001`
("authentication required") and an English message hinting the user
to copy their bridge key from the Sidetrack settings panel.

## Bootstrap

Add a CLI flag to the companion: `--mcp` (default on) /
`--no-mcp` (off). When on, `runtime/start.ts` boots two listeners in
parallel:

1. The existing HTTP server on `:17373` (or whatever the user
   configured).
2. The MCP server on `:8721` (configurable via `--mcp-port`).

Use `Promise.all` for startup; `Promise.race` for shutdown so a
crash on either bubbles out and lets `process.exit` clean both up.

## Tests

- **Protocol conformance** — drive a `tools/list` and `tools/call`
  cycle against an in-memory MCP client. Assert the response shape
  matches the published schema.
- **Cross-transport parity** — boot the same handler logic against
  stdio and WebSocket transports; assert identical output for
  `bac.read_thread_md` of a fixture thread.
- **Auth** — bridge key missing → `-32001`; wrong key → `-32001`;
  right key → success.
- **Golden integration test** — spawn a real Claude Code-style
  stdio client (the SDK ships one), connect, list tools, call
  `bac.read_thread_md`, assert the markdown matches the fixture.

## Roll-out

1. Land the spec doc (this file).
2. Implement `mcp/` module behind the `--mcp` flag, default off.
3. Verify against Claude Code locally (`claude --mcp ws://...`).
4. Flip `--mcp` default on once the protocol conformance suite is
   green.
5. Update `docs/mcp/README.md` to mention the JSON-RPC surface.
6. Update the side-panel's Send-to → coding-agent copy template
   (`PacketComposer.tsx::buildCodingAgentPacket`) to include the
   `ws://127.0.0.1:8721/mcp` endpoint as the primary route, with
   the existing HTTP+headers surface as fallback.

## Open questions for the implementer

- **Vault unbound state**. If the companion is started without a
  vault path, MCP `tools/list` should still return the schema (so
  the client can introspect) but every `tools/call` should error
  with a clear "no vault bound" message. Confirm this matches the
  HTTP surface's behavior — it currently returns 503 when the
  vault is unreachable.
- **Streaming responses**. `bac.recall` could stream incremental
  matches as the vector index walks. Worth doing? MCP supports
  partial-content responses but the SDK's TS types are still rough
  on it. Defer unless an agent specifically asks.
- **Pagination**. `bac.list_dispatches` already takes `limit` /
  `since`. Mirror that on the MCP side as input schema. No cursor
  state — pagination is client-driven.

## Reference

- MCP spec: https://spec.modelcontextprotocol.io/specification/2025-03-26/
- TypeScript SDK: https://github.com/modelcontextprotocol/sdk
- v2 design mock: `switchboard/project/surfaces/mcp.jsx` (in the
  bundle the user pulled from claude.ai/design).

---

When you're done, link your PR back to this doc and update the
status header from `Spec` to `Shipped`.
