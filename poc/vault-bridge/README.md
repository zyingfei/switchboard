# Vault Bridge POC

This PoC tests the narrow architecture question:

```text
Chrome MV3 extension -> File System Access API -> vault/_BAC/*.jsonl -> Node reader / future MCP server
```

The goal is not a production bridge. It is to find out whether a user-picked vault folder can be the only bridge between the browser extension and a Node-side reader.

## Status

Implementation scaffold: complete

Feasibility verdict: partial, with two serious red flags

Pivot decision: do not build on this as the only bridge yet. U2 can write after a service-worker wake when permission remains granted, and U4 short-run iCloud tailing works. But U5/U1 permission persistence is shaky, and U6 sustained service-worker timers fail around the MV3 idle window. If follow-up testing confirms the `prompt` state recurs after normal service-worker restarts, the architecture should pivot to Native Messaging or a local daemon for reliable write ownership.

Live validation on 2026-04-26 used the user's iCloud test folder:

```text
/Users/yingfei/Library/Mobile Documents/com~apple~CloudDocs/tmp
```

## Pivot Direction

The U5/U6 results are not a bug to work around — they're the load-bearing
constraints of MV3 + FileSystemAccess as a writer substrate, and they kill
the "extension is the only owner of vault writes" architecture for any use
case that needs sustained or silent operation.

The architecture pivots to:

```text
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

What's preserved:

- Vault as canonical state. The companion writes plain Markdown / JSONL /
  `.canvas` / `.base` via Node `fs`. Substrate principle (BRAINSTORM
  §23.0) is unaffected; the writer just moves out of the browser.
- MCP read side. `npx bac-mcp --vault <path>` is unchanged. `poc/mcp-server`
  on `main` already validated this against fixtures.
- §27 sync semantics. Connection / sync-in / sync-out remain three
  separate concepts; both directions are owned by the companion.

What's lost:

- Single install. User installs (a) the extension and (b) the companion.
- "No separate process" simplicity.

What's gained:

- Silent capture. Companion holds OS-level filesystem access; user picks
  vault folder once at companion install; no browser permission revocation
  cycle.
- Sustained operations. Live-tabs flush, embedding-index rebuilds, batch
  syncs all run in the companion. SW death is no longer fatal.
- Browser-crash recovery. Captured-and-acknowledged data is durable;
  in-flight captures queue in `chrome.storage.local` and replay.

This maps to BRAINSTORM §26.6 Path B (the `local-bridge` daemon sketch),
previously framed as one of two PoC paths. The vault-bridge result
empirically eliminates the alternative; Path B is now the v1 writer
architecture.

The companion-side feasibility work is scoped as the next PoC. The five
unknowns it must answer (install path: NM vs localhost; companion
lifetime; auth; offline-queue policy; end-to-end demo) are *not*
filesystem-write feasibility — that's well-trodden — they're install-UX
and lifecycle.

## What Was Built

```text
extension/
  entrypoints/background.ts      MV3 service worker writer
  entrypoints/sidepanel/         React side panel
  src/vault/idb.ts               persisted FileSystemDirectoryHandle
  src/vault/fsAccess.ts          _BAC/events and _BAC/observations JSONL writes
reader/
  cli.ts                         Node tail reader for _BAC/events/<date>.jsonl
observations/
  RUNBOOK.md                     12-step manual test plan for U1-U6
  NOTES.md                       evidence log with partial live Chrome/iCloud results
```

The side panel exposes:

- `Pick vault folder`
- `Write test event`
- `Start tick`
- `Stop tick`
- `Grant stored vault` when Chrome reports the stored handle is no longer write-granted

The service worker writes synthetic events to:

```text
<vault>/_BAC/events/<YYYY-MM-DD>.jsonl
```

Every event write outcome is logged to:

```text
<vault>/_BAC/observations/run-<timestamp>.jsonl
```

Observation rows include timestamp, latency, ok/error, browser user agent, service-worker state, and write strategy. Observation writes are not recursively logged as additional observation rows.

## Write Strategy

The writer uses `FileSystemFileHandle.createWritable({ keepExistingData: true })`, seeks to the current file size, writes one newline-terminated JSON object, then closes the stream.

Why this fallback:

- The stable File System Access write path stages changes and reflects them on close; MDN documents that this is typically implemented with a temporary file that replaces the visible file when the stream closes.
- `keepExistingData: true` copies the existing file into the temporary file before writing.
- A portable File System Access `move()`/rename primitive is not reliable enough to make temp-file-then-move the primary path in this PoC.

Primary references:

- [MDN: FileSystemFileHandle.createWritable()](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable)
- [Chrome for Developers: File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)

The short iCloud run did not show partial JSONL lines. A longer cloud-sync run would still be useful before treating this as generally proven across providers.

## Run

Extension:

```sh
cd poc/vault-bridge/extension
npm install
npm run compile
npm test
npm run build
```

Reader:

```sh
cd poc/vault-bridge/reader
npm install
npm run compile
npm start -- --vault /path/to/test-vault
```

Use the Node reader or `tail -F` for manual tailing. Plain `tail -f` can miss File System Access-style replacement writes because it may continue following the old file descriptor; I reproduced that locally with a temp-file-then-rename simulation.

Load the extension from:

```text
poc/vault-bridge/extension/.output/chrome-mv3
```

Then follow [observations/RUNBOOK.md](observations/RUNBOOK.md).

## Verification So Far

Run locally on 2026-04-26:

- `extension`: `npm run compile`
- `extension`: `npm test`
- `extension`: `npm run build`
- `reader`: `npm run compile`
- `reader`: `npm start -- --help`
- `reader`: disposable `/tmp` tail smoke with a normal Node append
- local simulation showing `tail -f` misses atomic replacement while `tail -F` sees it
- live Chrome/iCloud manual write from side panel to Node reader
- live Chrome/iCloud short `Start tick` run to Node reader

Local environment:

- macOS 26.2, build 25C56
- Google Chrome 147.0.7727.102
- Node v25.8.2

## U1-U6 Outcome Matrix

| Unknown | Outcome | Evidence |
|---|---|---|
| U1 persisted handle across restart | Fail-risk / pending re-grant check | Stored handle worked across some SW restarts, then `queryPermission()` returned `prompt` inside the same Chrome session |
| U2 service worker write after wake | Acceptable-with-caveat | Manual writes from woken SW succeeded at 21.3 ms and 77 ms while permission was granted |
| U3 `_BAC/` append-only writes | Acceptable-with-caveat | iCloud file contained complete JSONL rows under `_BAC/events` and observation logs under `_BAC/observations`; no partial lines observed in short run |
| U4 Node immediate consistency | Pass for short iCloud run | Reader tailed manual event and tick sequence 2-30 from the iCloud folder; no partial lines observed |
| U5 permission UX | Fail-risk | Side panel surfaced `Needs grant (prompt)` after SW restart; normal write flow blocked until re-grant |
| U6 1 Hz sustained writes | Fail | Tick stopped at sequence 30; new SW start reset tick state, confirming SW-owned `setInterval` is not durable |

## MCP Server Re-Scope

Do not land a larger `poc/mcp-server` iteration on top of this bridge until the permission behavior is resolved.

If a follow-up test proves U1/U5 are only one-click once per browser session, the next `poc/mcp-server` iteration should be small:

1. Add a read-only vault event reader for `_BAC/events/*.jsonl`.
2. Add a tail/latest helper that tolerates files being replaced on close.
3. Expose the latest bridge events through the existing MCP runtime shape.
4. Keep writes extension-only; MCP remains read-only.
5. Add fixture JSONL logs plus one integration test that tails appended events.

If U1/U5 require repeated re-grants after ordinary service-worker restarts, skip this re-scope and evaluate Native Messaging or a local daemon as the bridge owner.

U6 also changes the sync-out shape: sustained 1 Hz writes cannot be owned by an MV3 service-worker timer. A future extension-only design would need event-driven writes, `chrome.alarms` for coarse cadence, or a non-service-worker owner for continuous sessions.

The optional `mcp-smoke.ts` was skipped to keep this PoC focused on the unknown write side. The existing `poc/mcp-server` already proves stdio MCP composition; duplicating that here would not answer U1-U6.

## BRAINSTORM Follow-Ups

- If U1 passes only with once-per-session re-grant, update §27-style connection setup language to distinguish "picked vault" from "currently write-granted vault."
- If U6 fails because MV3 service workers suspend during `setInterval`, record that sustained sync-out needs an event source, alarm cadence, Native Messaging host, or daemon. A service-worker timer should not be treated as durable infrastructure.
- If cloud-synced U4 shows delayed visibility or file replacement churn, document cloud vaults as acceptable-with-caveat and require a local-first debounce/read-after-write policy.
