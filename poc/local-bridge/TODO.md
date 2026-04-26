# TODO — `poc/local-bridge`

> **Instruction**: When the work in this TODO is complete, **delete this
> file** and **add `README.md`** documenting the chosen install path
> (Native Messaging vs localhost), the companion's lifetime story, the
> extension ↔ companion contract, and the end-to-end loop measurements.

## Status today (2026-04-26)

This PoC exists because **`poc/vault-bridge` (2026-04-26) empirically
eliminated the "extension-only owns vault writes" architecture** for
production use.

What was previously planned (and is now invalidated):

```
Extension ──FileSystemAccess──▶ Vault ──fs──▶ bac-mcp ──stdio──▶ Coding agent
```

What `poc/vault-bridge` actually found in live Chrome + iCloud testing:

| Test | Outcome | Implication |
|---|---|---|
| **U6 sustained 1 Hz** | **Fail** — SW timer stopped at sequence 30 (~30s, MV3 idle window) | MV3 service workers cannot host continuous timers. Live-tab tick, periodic state flush, sustained sync-out are all dead in this design. |
| **U5 permission UX** | **Fail-risk** — `queryPermission()` returned `prompt` after a SW restart inside the same Chrome session; capture flow blocked until user clicked re-grant | "Silent capture" is not achievable when permission state is tied to SW lifecycle. Every SW restart could mean a re-grant click. |
| **U1 handle persistence** | Fail-risk (paired with U5) — handle persisted, but permission did not | The persisted-handle pattern is necessary but not sufficient. |
| U2 SW write after wake | Acceptable-with-caveat — works *when permission is granted* | Data path is fine; problem is holding the position. |
| U3, U4 | Acceptable / Pass on the data path | Filesystem semantics, JSONL append, cross-process read all behaved correctly. |

**Net**: the failure isn't filesystem — it's MV3 lifecycle and FileSystem-
Access permission state. Both are properties of the browser the extension
runs inside, and neither is changeable from extension code.

## The pivot — what this PoC is for

Add a **companion process** between the extension and the vault, owning all
filesystem writes and any sustained operations:

```
                       ┌─ HTTP/WS or Native Messaging
Extension (sensor) ────┤
                       │
                       ▼
              ┌──────────────────────┐
              │ Companion (writer)   │  long-lived process
              │   - holds vault path │  (no permission UX —
              │   - owns all writes  │   path is OS-level)
              │   - runs sustained   │  (survives SW deaths,
              │     tasks (tick,     │   browser closes,
              │     index rebuild)   │   reboots if started)
              └──────────┬───────────┘
                         │ Node fs
                         ▼
              ┌──────────────────────┐
              │ Vault folder (canon) │
              └──────────┬───────────┘
                         │ Node fs
                         ▼
              ┌──────────────────────┐
              │ bac-mcp (reader)     │  spawned per MCP client
              └──────────────────────┘
```

This maps to **BRAINSTORM §26.6 Path B** (the `local-bridge` daemon
sketch), which was previously framed as one of two PoC paths. With
`poc/vault-bridge`'s empirical result, Path B is no longer an alternative
— it's the v1 writer architecture.

What stays the same:

- **§23.0**: vault is canonical; substrate is filesystem + Markdown +
  frontmatter + `.canvas` + `.base` + `_BAC/`. Plugins remain opt-in
  acceleration. Companion writes via plain Node `fs`; no Local REST API
  required.
- **§27**: connection setup / sync-in / sync-out are still three separate
  concepts. The writer end of sync-out moves into the companion; the
  reader end (sync-in) moves into the companion too (it's the process
  that has filesystem access for both directions).
- **MCP read side**: `npx bac-mcp --vault <path>` is unchanged. The
  existing `poc/mcp-server` PoC on `main` already validated this.
- **User-owned data**: companion is local-only, no cloud, single-user
  trust boundary.

What's lost:

- Single install. User now installs (a) the Chrome extension and (b) the
  companion. Documented elsewhere as the install-funnel cost (§24.3n).
- "No separate process" simplicity. There's a daemon now.

What's gained:

- **Silent capture** is recoverable. Companion holds OS-level filesystem
  access; user picks vault folder once at companion install (or via the
  extension delegating to the companion); no browser re-grant cycle.
- **Sustained operations work**. Live-tabs flush, embedding-index
  rebuilds, batch syncs all run in the companion. SW death is no longer
  fatal to anything.
- **Browser-crash recovery**. Captured-and-acknowledged data is durable
  in the vault; in-flight captures queue in `chrome.storage.local` and
  replay when the companion is reachable.

## Architectural questions to resolve

This PoC is **not** about validating that companion-writes-to-vault works
— Node + `fs` is well-trodden. The real unknowns are at the install-UX
and lifecycle boundary.

- **Q1.** **Install path**: Native Messaging vs localhost HTTP/WS.
  - Native Messaging: extension talks to companion via stdin/stdout
    through Chrome's NM API. Install needs a paired manifest (Windows
    registry entry / macOS plist / Linux dotfile) + binary. Per-extension
    pairing.
  - Localhost HTTP/WS: extension hits `127.0.0.1:<port>`. Companion is an
    `npx`-installable Node process or a system service. Easier install
    (`npx bac-companion`) but adds port management, token auth, and
    "is the companion running?" UX.
  - **Decide:** which one feels less friction for a power user installing
    across N coding-agent clients?
- **Q2.** **Companion lifetime**: auto-start on login, manual start,
  user-system-service install (`launchd` / `systemd` / `Task Scheduler`)?
  How does the user know when it's down? Recovery path?
- **Q3.** **Auth between extension and companion**:
  - Native Messaging: capability granted by paired manifest (no token
    needed, but extension ID is the auth).
  - HTTP/WS: random API key generated at first companion start, stored in
    a known location (e.g. `_BAC/.config/bridge.key`); extension reads on
    first connect; rejects non-local origins.
- **Q4.** **Offline / disconnection behavior**: when the companion is
  down, the extension queues captures locally. When the companion comes
  back, replay. **Decide:** queue size limits, replay ordering
  (chronological vs newest-first), conflict semantics if a capture lands
  in both `chrome.storage.local` and the vault.
- **Q5.** **End-to-end demo**: extension capture (real provider tab) →
  companion vault write → `bac-mcp` reads → coding-agent tool call
  returns the captured data within ~30 s. Same demo as the original
  `poc/mcp-server` re-scope, but with the companion in the middle.

## Pre-build gates

- [ ] User confirms Path B (companion architecture) is the v1 writer
  architecture, not just a PoC exploration. The vault-bridge empirical
  result is the basis; this PoC builds on that decision.
- [ ] Decide Q1 install path **before** scaffolding — different choice
  means different host-process project shape.

## Remaining scope

### Companion process (resolves Q1 build, Q2, Q3)

- [ ] Scaffold `poc/local-bridge/companion/` as a Node 22+ TypeScript
  project. Keep dependencies minimal: `@modelcontextprotocol/sdk`
  (optional, if hosting MCP from same process), `zod` for input
  validation, no web framework if Native Messaging path; Hono / Fastify
  if localhost HTTP path.
- [ ] Implement `VaultBinding` (§27) write side: `writeNote`,
  `patchFrontmatter`, `attachToTrack` over plain Node `fs` with
  temp-file-then-rename atomic semantics.
- [ ] Implement transport per Q1 choice (NM stdio loop OR localhost
  WebSocket on `127.0.0.1`).
- [ ] Implement auth per Q3 (NM extension-ID gating OR API-key gating).
- [ ] Implement event-log writer for `_BAC/events/<date>.jsonl` and the
  observation log shape used by `poc/vault-bridge`.
- [ ] Lifetime: minimal v1 — runs in foreground, logs to stderr. Defer
  auto-start / system-service integration to v1 productization.

### Extension changes (resolves Q4)

- [ ] Fork `poc/vault-bridge/extension/` (or treat as starting point) and
  swap the FileSystemAccess writer for an HTTP/NM client. Keep the same
  side-panel surface for the U1–U6 manual tests, plus a new "companion
  status" badge.
- [ ] Implement local capture queue in `chrome.storage.local`: append on
  capture, drain on companion-reachable, retain ordering. Cap at N items
  (e.g. 1000) with oldest-eviction policy.
- [ ] Surface "companion: connected / disconnected / queued N items" in
  the side panel.

### MCP reader (no changes; verify only)

- [ ] Point existing `poc/mcp-server` at the companion-written vault.
  Confirm `bac.recent_threads`, `bac.context_pack`, etc., return the
  expected data. No code changes expected — this is composition test.

### Tests

- [ ] Unit (Vitest): `VaultBinding` write semantics, queue replay,
  auth rejection.
- [ ] Integration: extension posts a synthetic capture → companion
  writes vault → `bac-mcp` returns it via stdio harness call.
- [ ] Manual: 60-minute companion-tick sustained run (replicates
  vault-bridge U6 with companion as writer) — should now pass since
  companion isn't subject to MV3 idle.
- [ ] Manual: extension → companion offline → captures queue →
  companion back → captures drain. Verify ordering.

### Documentation

- [ ] On completion: delete this `TODO.md` and write `README.md`
  documenting:
  - Install path chosen (Q1) and rationale
  - Companion lifetime story (Q2) — first-run, auto-restart, recovery
  - Extension ↔ companion contract (Q3) — auth, message shapes
  - Offline/queue policy (Q4) — replay ordering, size limits
  - End-to-end demo evidence (Q5) — capture → vault → MCP latency, error
    rates over a realistic session
  - Comparison to vault-bridge: confirm U6 / U5 are now resolved

## Out of scope (defer)

- Production installer (`pkg`, `notarized .pkg`, MSI, deb/rpm) — first
  prove the contract; package later.
- Multi-vault routing — single vault per companion instance.
- Companion auto-update — manual `npx` upgrade for now.
- BAC's MCP server hosted by companion — clean separation: companion
  writes; `bac-mcp` reads; two processes. Combine as an optimization
  later if there's signal.
- Sync-in (vault → BAC) reconciliation policy beyond the write path.
- Inline-review write tools (§28) — read-only MCP tools only for v1.

## Reference: BRAINSTORM updates this PoC depends on

- §23.0 — interfaces & core (substrate); plugins opt-in. Companion
  satisfies this trivially (Node `fs` is the most "interface-and-core"
  write path possible).
- §27 — connection / sync-in / sync-out separation. Companion owns both
  the connection state (it holds the vault path) and the sync directions.
- §27.6 (added 2026-04-26 on the brainstorm PR branch) — empirical
  finding that pivots Path B from alternative to v1 writer anchor.
- §26.6 — original Path B sketch. This PoC is the implementation of that
  sketch, scoped to the unknowns above.
