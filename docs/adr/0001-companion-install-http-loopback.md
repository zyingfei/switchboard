# ADR-0001 — Companion install path: HTTP loopback over Native Messaging

**Status**: Accepted (2026-04-26)
**Decider**: User + Claude
**Related**: PRD §5 (architecture), PRD §11 Q4, BRAINSTORM §27.6
(vault-bridge empirical pivot), `poc/local-bridge` planning artifact
(on `poc-planning` branch).

## Context

Per BRAINSTORM §27.6, the v1 Sidetrack writer architecture requires a
**long-lived companion process** between the Chrome MV3 extension and
the vault. The companion holds OS-level filesystem access (no browser
permission UX), survives service-worker death, and runs sustained
tasks (live-tabs flush, embedding-index rebuild, batch sync) that the
extension cannot.

Two install paths were on the table for getting messages from the
extension to the companion:

- **A. HTTP loopback**: companion is a detached Node process, binds
  `127.0.0.1:<port>`, extension calls via `fetch`/WebSocket. Install
  via `npx @sidetrack/companion --vault <path>` (or global install).
- **B. Native Messaging host**: companion binary launched by Chrome
  via `chrome.runtime.connectNative()`; communicates over
  stdin/stdout (length-prefixed JSON). Install via OS-specific host
  manifest (registry on Windows, plist on macOS, dotfile on Linux)
  plus binary at the manifest-named path.

Both paths can move bytes between extension and companion. The
decisive question is: **which path satisfies the architectural
requirements without forcing the companion's lifetime to depend on
Chrome's process?**

## Decision

**Adopt HTTP loopback (Option A)** as the default companion install
path for v1. Native Messaging is rejected for v1 and not a v1 fallback.

In v1.5, ship an `--install-service` flag that wires the companion
into the OS init system (`launchd` on macOS, `systemd` on Linux, Task
Scheduler on Windows) so users don't need to manually start the
companion after every machine reboot.

## Rationale

The decisive factor is **lifetime**. Per §27.6, the companion must
survive: SW death (✓ both options), Chrome restart (✓ HTTP only),
sustained background tasks like live-tabs flush and embedding rebuilds
(✓ HTTP only).

Native Messaging hosts are spawned as **child processes of Chrome**
when an extension calls `connectNative()`. When the extension's port
disconnects (extension reload, Chrome quit, last tab closed for some
flows), Chrome closes stdin to the host; the host normally exits.
Making a NM host long-lived requires daemonization gymnastics (host
forks a detached child on first launch, the NM-handled parent exits,
the detached child runs forever) — possible but complex, defeats the
simplicity advantage NM otherwise has, and is not standard.

HTTP loopback decouples the companion's lifetime from Chrome
entirely. The companion is a Node process the user starts once;
multiple Chrome restarts, multiple browsers, even no browser at all
do not affect it. Sustained tasks run in the companion at its own
cadence.

Secondary factors that confirm the decision:

- **Multi-MCP-client neutrality**: HTTP loopback serves N MCP clients
  (Claude Code, Cursor, Codex, future) with one install. Native
  Messaging requires per-extension manifest pairing — adding a new
  MCP client would mean a new install.
- **Standard pattern in ecosystem**: `mcp-chrome`, `browser-mcp`, the
  Obsidian Local REST API plugin, and most modern MV3-companion
  tools converged on HTTP loopback for the same lifetime reasons.
  Choosing it puts Sidetrack in well-trodden territory.
- **Cross-platform parity**: `npx @sidetrack/companion` is one
  command on macOS / Linux / Windows. Native Messaging requires
  per-OS manifest paths and (on Windows) registry writes.
- **Debuggability**: `curl http://127.0.0.1:<port>/v1/health` works
  out of the box. Native Messaging requires Chrome's NM logging to
  see what's happening on the wire.
- **Update path**: `npm update -g @sidetrack/companion` is standard;
  Native Messaging requires manual binary replacement.

## Consequences

### Positive

- Companion lifetime is correct for the architecture (§27.6).
- One companion serves all MCP clients.
- Standard install (`npx`) cross-platform.
- Debuggable with normal HTTP tools.
- Hot-reload during dev is trivial.

### Negative (acknowledged, mitigated)

- **Port management**: companion must bind a port. Mitigation: try
  default `7042`, fall back through a small range, write the chosen
  port to `<vault>/_BAC/.config/bridge.config` so the extension
  knows where to look. Document collision handling in `poc/local-bridge`.
- **macOS firewall prompt**: first bind on macOS may show "Accept
  incoming network connections?" Mitigation: bind to `127.0.0.1`
  explicitly (not `0.0.0.0`); document the one-time prompt in the
  first-run wizard with an italic-serif explanation.
- **"Is the companion running?" UX**: extension can't auto-launch
  the companion (browser sandboxing). Mitigation: side-panel
  "companion: disconnected" badge with a one-click retry; first-run
  wizard shows the install snippet and a live "waiting for
  companion…" check that turns green when reachable; v1.5 ships
  `--install-service`.
- **Process management is the user's responsibility for v1**.
  Mitigation: clear documentation; v1.5 system-service installer
  removes the burden entirely.

### What this rejects

- **Native Messaging**: stays as a back-pocket option only if Sidetrack
  ever pivots toward live-browser-control SKU positioning where
  Chrome-tightly-coupled behavior is the value proposition. Not
  needed for the active-workstream-tracker product.

## Auth model

Random API key generated at first companion start, written to
`<vault>/_BAC/.config/bridge.key` (mode 600). Extension reads the
keyfile via FileSystemAccess on first connect, caches in
`chrome.storage.local`. Every extension request includes
`Authorization: Bearer <key>`. Companion rejects non-`127.0.0.1`
origins explicitly (CORS strict). Key rotation: delete `bridge.key`,
restart companion, re-grant from extension.

## Implementation pointers

- See `poc/local-bridge/TODO.md` (on the `poc-planning` branch) for
  the next-iteration scope: companion scaffold, transport
  implementation, auth, offline queue, end-to-end demo.
- The `bac-mcp` reader (already on main from `poc/mcp-server`) is
  unchanged — it reads the vault directly via Node `fs` and does
  not go through the companion's HTTP at all. The companion is the
  writer; the MCP server is the reader.

## References

- BRAINSTORM.md §27.6 (vault-bridge empirical pivot, 2026-04-26)
- BRAINSTORM.md §26.6 (Path B / `local-bridge` daemon sketch)
- `poc/vault-bridge/observations/NOTES.md` (U1–U6 outcomes)
- `poc/local-bridge/TODO.md` on `poc-planning` (companion-PoC plan)
- `mcp-chrome` and `browser-mcp` projects (HTTP-loopback prior art)
- Chrome Native Messaging docs (the path not taken):
  https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
