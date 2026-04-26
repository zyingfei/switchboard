# TODO — `poc/vault-bridge`

> **Instruction**: When the work in this TODO is complete, **delete this
> file** and **add `README.md`** documenting the outcomes for U1–U6
> (pass / fail / quirks per browser), the chosen pivot if any, and the
> implications for the broader BAC architecture. The README is the
> handoff to whoever scopes the next iteration of `poc/mcp-server`.

## Status today

Folder created, no code yet. This `TODO.md` is the planning artifact
until the post-build README replaces it.

## Scope summary (one-liner)

A feasibility smoke-test of the **vault-as-bridge** architecture: prove
(or disprove) that a Chrome MV3 extension can durably write to a
filesystem location that a separate Node process can read, with
acceptable permission UX and lifecycle behavior. **Not** a production
build, not a feature PoC — purely a yes/no answer on the load-bearing
unknowns.

## Architecture under test

```
┌──────────────────────────┐                    ┌──────────────────────────┐
│ Chrome MV3 extension     │                    │ Node reader              │
│  side panel:             │                    │  cli.ts (this PoC)       │
│   - "Pick vault folder"  │                    │  optional: stdio MCP     │
│   - "Write test event"   │                    │     smoke with one tool  │
│  service worker:         │                    └────────────┬─────────────┘
│   - persists handle      │                                 │ Node fs
│   - writes JSONL on      │                                 │
│     event-driven wake    │                                 │
└────────────┬─────────────┘                                 │
             │ FileSystemAccess API                          │
             │                                               │
             ↓                                               ↓
   ┌─────────────────────────────────────────────────────────────────┐
   │  vault folder (any folder the user picks; could be Obsidian)    │
   │     _BAC/events/<date>.jsonl     append-only synthetic events   │
   └─────────────────────────────────────────────────────────────────┘
```

The PoC writes synthetic events. No real provider capture, no Obsidian
formatting, no MCP tool surface beyond a smoke. Everything in this PoC
is in service of resolving U1–U6 below.

## The six unknowns this PoC must resolve

| # | Unknown | Pass criterion | Fail pivot |
|---|---|---|---|
| **U1** | `showDirectoryPicker()` from the side panel + persisted handle in IndexedDB → re-acquire across browser restart **without re-prompting on every use** | After first pick, no permission prompt for ≥7 days of normal browser usage (or, if a re-grant prompt is required, it is once per browser-session at most and is one-click) | Daemon helper holds long-lived FS access |
| **U2** | The **service worker** can write through the persisted handle, including after SW restart triggered by an event-driven wake (capture event) | Synthetic capture from a wake event writes a JSONL line within 1 s, including after the SW has been idle ≥30 s and just woken | Offscreen document holds the handle; SW posts data to offscreen for write |
| **U3** | Create + atomically write into a `_BAC/` subfolder under the vault, no disturbance to user files | `_BAC/events/<date>.jsonl` is append-only; concurrent reads from Node never see partial lines; no other user files touched | Plain overwrite + tail-marker; or sync to OPFS first then mirror |
| **U4** | A separately-spawned Node process can read the latest written line **immediately** and **consistently** (no partial-write tearing, including on cloud-synced vaults) | Node reader sees a new JSONL line within 1 s of extension write; tested on a local folder AND on an iCloud / Dropbox / OneDrive folder | File-lock + checksum protocol; or daemon-mediated writes |
| **U5** | Permission UX is acceptable: one folder picker at first run, then silent (or at most a clear, infrequent re-grant) | User can leave the extension running across reboots without seeing a permission prompt during normal capture flow; any re-grant is single-click and obvious why | Either daemon (long-lived handle), or accept friction and design around it |
| **U6** | Holds up under realistic write rate (~1 write/sec under heavy chat) for a full session without throttling, quota errors, or perf cliff | 1 write/sec sustained for 60 minutes, no errors, p95 write latency <100 ms, no service-worker death | Batch writes (flush every N seconds); or move durable substrate to OPFS + periodic export to vault |

These are the only questions worth answering in this PoC. Anything else
is downstream and not feasibility.

## Build scope

### Extension (`poc/vault-bridge/extension/`)

- WXT + React + TypeScript MV3, mirroring the layout of existing PoCs.
- **Side panel**: two buttons.
  1. *Pick vault folder* — calls `showDirectoryPicker()`, persists the
     returned `FileSystemDirectoryHandle` to IndexedDB.
  2. *Write test event* — sends a message to the SW; SW writes one
     JSONL line. Used for manual interactive testing of U2.
  3. (Optional) *Start tick* — kicks off a 1-Hz timer in the SW that
     writes synthetic capture events for U6 stress.
- **Service worker**:
  - On startup, re-acquires the handle from IndexedDB; if
    `requestPermission()` returns prompt, surface to side panel.
  - On capture event, opens (or creates) `<vault>/_BAC/events/<YYYY-MM-DD>.jsonl`
    via the handle; appends one JSON line; flushes.
  - Atomic write via temp-file-then-`move` (FileSystemWritableFileStream
    + `move()` if available) — or document the fallback used.
- **Telemetry to disk** (also in the vault, separate file):
  `_BAC/observations/run-<timestamp>.jsonl` — per-write outcome:
  timestamp, latency, error/success, browser version, SW state.
  Used to generate U1–U6 pass/fail evidence in the README.

### Reader (`poc/vault-bridge/reader/`)

- Node 22+, TypeScript, no deps beyond `@modelcontextprotocol/sdk`
  (optional, for the MCP smoke).
- `cli.ts` — takes `--vault <path>`; tail-watches
  `<vault>/_BAC/events/<YYYY-MM-DD>.jsonl`; prints each new line.
  Exercises U4 (cross-process consistency).
- (Optional) `mcp-smoke.ts` — minimal stdio MCP server with one tool
  `bridge.tail(n)` returning the last N events. Wire to one MCP client
  to confirm the read side composes; not a v1 packaging effort.

### Observation harness (`poc/vault-bridge/observations/`)

- A `NOTES.md` file the implementer keeps as they run the PoC. One
  section per U1–U6 with: what was tested, what happened, screenshots
  / clip URLs, browser version, OS. This becomes the seed for the
  post-build README.

## Pass / pivot / fail outcomes

For each Ui:

- **Pass** → the architecture's substrate works for that property; capture in the README.
- **Acceptable with caveat** → works but with a UX or perf wrinkle worth flagging at v1 design time; capture the workaround.
- **Fail** → triggers the pivot named in the U-table above. Document the failure mode + the proposed pivot.

**If U1 or U2 fail outright**, the vault-as-bridge architecture as
sketched is not viable for the extension-write side. The PoC's
deliverable is then the *evidence* and a recommendation between
(a) Native Messaging companion or (b) localhost daemon helper. Either
way the Node reader side from this PoC carries forward unchanged.

## Tests

- Unit (Vitest): handle-persistence wrapper, JSONL writer, atomic-write
  fallback, IndexedDB re-acquire flow.
- Manual: 12-step interactive run-book in `observations/RUNBOOK.md`
  covering each Ui, including a browser-restart step (U1) and an
  iCloud / Dropbox / OneDrive variant (U4). The implementer runs it,
  fills in observations.
- Optional Playwright: extension e2e for the deterministic parts
  (U3 atomic write, U6 sustained-write throughput). Skip for U1, U2,
  U4, U5 — those need real-OS / real-restart context that Playwright
  can't reproduce cleanly.

## Out of scope (do not build)

- Real provider-capture integration — synthesize fake events.
- Obsidian-shape (frontmatter, `.canvas`, `.base`, Source notes) — raw
  JSONL only.
- VaultBinding interface (§27) — direct calls, no abstraction.
- Production MCP tool surface (`bac.recent_threads` etc.) — only the
  optional `bridge.tail` smoke.
- `npx bac-mcp` packaging — irrelevant to feasibility.
- Cross-MCP-client validation — one stdio harness is enough.
- Live tabs freshness — irrelevant to feasibility.
- Anything from the prior `poc/mcp-server/TODO-v2.md` superseded by
  this PoC. After this PoC's outcomes are in, the next mcp-server
  iteration gets re-scoped against the validated substrate.

## Documentation handoff

On completion: delete this `TODO.md` and write `poc/vault-bridge/README.md`
documenting:

- **Outcomes per U1–U6**: pass / acceptable-with-caveat / fail, with
  evidence (numbers + screenshots + reproduction steps).
- **Browser-version / OS matrix**: at minimum Chrome stable on macOS;
  ideally also Chrome on Windows + Linux, and Edge on Windows.
- **The pivot decision**: if any U failed, which pivot was chosen and
  why.
- **Implications for `poc/mcp-server` next iteration**: a 1-page
  re-scope of what should land in the next mcp-server PoC given what
  was learned here.
- **Anything that surprised the implementer** that should feed back
  into BRAINSTORM.
