# TODO — `poc/mcp-server`

> **Instruction**: When the work in this TODO is complete, **delete this
> file** and **add `README.md`** documenting what was built (host process
> + transport chosen, client-integration results, security boundary,
> setup UX, lessons).

## Status today

Folder created, no code yet, no planning README yet. This `TODO.md` is
the planning artifact until the post-build README replaces it.

## Scope summary (one-liner)

Promote PoC-1's in-process JSON-RPC MCP-core smoke into a real
`@modelcontextprotocol/sdk` server with a real transport and a real
security boundary, then validate it against Claude Code, Cursor, and
Codex CLI consuming `bac.recent_threads`, `bac.workstream`,
`bac.context_pack`, `bac.search`, and `bac.recall`.

## Architectural questions to resolve

- **Q1.** **Host process**: extension service-worker (with keep-alive
  pattern) vs paired-down localhost companion daemon (per §26 Path B).
  §24 prefers the daemon for lifetime reasons; this PoC confirms or
  revises.
- **Q2.** **Transport**: WebSocket localhost (BAC-as-server) vs stdio
  (MCP client launches BAC as subprocess). §24 prefers
  WebSocket-localhost.
- **Q3.** **Discovery / setup UX**: how does a Claude Code / Cursor /
  Codex user point their client at BAC? Config snippet, side-panel
  surface, key copy-paste.
- **Q4.** **Service-worker viability**: if Q1 picks the extension path,
  can the keep-alive pattern hold a stable MCP endpoint long enough
  for a real coding session?

## Pre-build gates

- [ ] Confirm dependencies have landed:
  - `poc/dogfood-loop` MCP contract module locked
  - `poc/provider-capture` `bac.recent_threads` reader interface ready
  - `poc/obsidian-integration` `bac.workstream` and
    `bac.context_pack` readers ready
  - `poc/recall-vector` `bac.recall` and `bac.search` readers ready
- [ ] Decide host-process path (Q1) before scaffolding — different
  host chooses different scaffolding (extension WXT addition vs Node
  daemon project).

## Remaining scope

### Architecture decisions (the architectural-fork PoC questions)

- [ ] **Q1**: pick host process. If extension service-worker: document
  keep-alive pattern + lifetime risk. If daemon: this folder absorbs
  the §26 Path B scope (Node 22+ + Hono / Fastify; SQLite event store
  may be unnecessary if vault is canonical per
  `poc/obsidian-integration` — reassess).
- [ ] **Q2**: pick transport. If WebSocket localhost: bind to
  `127.0.0.1` only. If stdio: document subprocess lifecycle.
- [ ] **Q3**: design setup UX. Side-panel "MCP server: running on
  ws://127.0.0.1:<port> — copy this into your Claude Code config"
  snippet. Document the snippet for each of Claude Code, Cursor,
  Codex CLI.

### Implementation

- [ ] Implement `@modelcontextprotocol/sdk` server with `tools/list` +
  `tools/call` for the canonical contract from `poc/dogfood-loop`.
- [ ] Wire reader interfaces from each upstream PoC:
  - `bac.recent_threads` ← `poc/provider-capture`
  - `bac.workstream` ← `poc/obsidian-integration`
  - `bac.context_pack` ← `poc/obsidian-integration`
  - `bac.search` ← `poc/dogfood-loop` (lexical) + optional vector
    blend from `poc/recall-vector`
  - `bac.recall` ← `poc/recall-vector`
- [ ] Bundle / package the server so the chosen host process can
  actually run it (extension build with WXT, or Node bundle for
  daemon).

### Security boundary

- [ ] Bind to `127.0.0.1` only.
- [ ] Generate random API key on first start; persist locally (vault
  `_BAC/.mcp/key` or extension storage); surface for copy / paste.
- [ ] Reject requests without token; reject non-local origins.
- [ ] Read-only by default; write tools (e.g. `bac.append_decision`)
  deferred until explicit opt-in design.
- [ ] Audit log every tool call as an event in the vault
  (`_BAC/events/<date>.jsonl`).
- [ ] Honor screen-share-safe mode if `getDisplayMedia` permission is
  active (mask sensitive returns; coordinate with
  `poc/recall-vector`).

### Validation against real clients (the moat test)

- [ ] **Claude Code** (`claude --chrome` precedent): configure to
  consume BAC as MCP server; run a real coding task that uses
  `bac.context_pack` or `bac.recall`. Document setup steps and
  outcome.
- [ ] **Cursor**: same pattern.
- [ ] **Codex CLI**: same pattern.
- [ ] For each client, document: which tools were most useful,
  smoothness of setup, any shape mismatches that required upstream
  contract revision.

### Coordination with upstream PoCs

- [ ] If contract drift surfaces during validation, push the fix back
  to `poc/dogfood-loop` (contract owner) and re-confirm all
  downstream readers honor the revised shape.
- [ ] Document any reader-interface refactors needed in upstream PoCs
  to support real MCP usage (e.g. pagination, streaming).

### Tests

- [ ] Unit: tool handler routing, schema validation, error mapping,
  token gate, origin check.
- [ ] Integration: in-process MCP client driving the server through
  the chosen transport; assert each tool returns the expected shape
  against fixture upstream readers.
- [ ] Manual: real-client validation per "Validation" section above.

### Documentation

- [ ] On completion: delete this `TODO.md` and write the post-build
  README documenting:
  - host process + transport chosen, with rationale
  - setup snippet + side-panel UX (with screenshots)
  - tool surface (link to canonical contract in `poc/dogfood-loop`)
  - security boundary (binding, token, read-only, audit log)
  - real-client validation results (Claude Code, Cursor, Codex CLI)
  - any contract revisions pushed upstream and why
  - lifetime / robustness notes for v1 productization

## Out of scope here

- Write tools (e.g. `bac.append_decision`, `bac.mark_archived`) —
  deferred until v1 explicit-opt-in design lands. Read-only in this PoC.
- Multi-tenant / multi-vault MCP — single-user local trust boundary
  only (matches §24 v1 scope).
- BAC-as-MCP-host (consuming user's other MCP servers) — separate
  scope, not this PoC.
- Encrypted-backup hooks for MCP audit log — separate v1 implementation
  (S137).
- Generic browser automation tools (page navigation, form fill, etc.)
  — explicitly not BAC's positioning. Other MCP servers cover that.
