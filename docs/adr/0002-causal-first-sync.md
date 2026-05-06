# ADR-0002 — Causal-first multi-replica sync

**Status**: Accepted (2026-05-06)
**Decider**: User + Claude
**Related**: PRD §M2 (sync), BRAINSTORM §27 (replica boundary), §28
(CRDT sketch), ADR-0001 (companion-install path), PR #92 (MCP
refactor that landed the per-replica metadata fields on the recall
index).

## Context

Sidetrack runs as a long-lived companion process per host. Two
behaviours were missing in M1 and blocked multi-machine usage:

1. **Browser-to-browser sync.** Switching browsers (Chrome → Brave on
   one box, or Mac → laptop) lost `chrome.storage`-only state — most
   painfully **inline-review drafts** authored from the `+ Comment`
   chip. Drafts only landed in the vault when the user explicitly
   submitted them; until then a browser swap deleted hours of work.
2. **Recall-index ↔ vault drift.** `POST /v1/events` wrote the
   capture JSONL but never ran `appendEntry`, so newly captured turns
   weren't searchable until the next manual rebuild. Hard thread
   delete bypassed `gcEntries`. No quantitative drift metric. Orphan
   `.tmp` files accumulated from mid-write crashes.

Direct vault-file syncing (Dropbox/iCloud) was rejected up front:
two replicas appending the same JSONL day file or rewriting the
same `index.bin` at the same time corrupt one another deterministically.

Lamport-ordered LWW was the obvious next idea but has a different
problem: a host whose clock runs faster (or whose first-event
timestamp happens to be later) wins every concurrent edit, even
when the user on the slow host typed last. The branch-2 design
review made this concrete: "Host A's clock could be ahead and keep
winning."

## Decision

**Sidetrack sync is event-sourced and causal-first.** Each companion
is a replica that appends immutable events to a per-replica log.
Browser edits carry the projection vector the user actually
observed. Scalar fields use causal registers: an edit supersedes
another only if it causally observed it; truly concurrent edits are
preserved as conflict candidates. HLC timestamps are advisory
metadata for display and optional heuristics, never the primary
correctness rule.

The architecture lands across four PRs (this branch is PR1–PR4):

### PR 1 — Sync foundation + review draft sync

Establishes the durable substrate every other PR builds on.

- `src/sync/causal.ts` — `Dot { replicaId, seq }`, `VersionVector`,
  `AcceptedEvent { clientEventId, dot, deps, … }`, `vectorCovers`,
  `eventDominates`, `mergeRegister` (resolved | conflict).
- `src/sync/replicaId.ts` — UUID v4 + per-replica monotonic seq
  counter persisted at `_BAC/.config/replica-id` and
  `_BAC/.config/replica-seq`. The seq is local to its replica; it is
  NOT a Lamport scalar across replicas.
- `src/sync/eventLog.ts` — `appendClient(input)` is the only durable
  write path. It:
  1. Returns the existing `AcceptedEvent` if the client retried
     (same `clientEventId`) — same dot, same `acceptedAtMs`.
     Idempotent under retry.
  2. Otherwise allocates a fresh seq, stamps `deps` from the
     client's `baseVector` **verbatim** — never the companion's
     current frontier. (See `eventLog.test.ts` for the test that
     proves an offline browser edit drained after peer events lands
     here does NOT silently inherit deps it never observed.) Appends
     to `_BAC/log/<replicaId>/<YYYY-MM-DD>.jsonl`.
- `src/sync/transport.ts` — `LogTransport` interface + `LocalFs`
  (peers see writes via filesystem) + `InMemory` (tests).
- `src/review/projection.ts` — `projectReviewDraft` uses
  `eventDominates` + `mergeRegister` for comments / overall /
  verdict; observed-remove for spans (add-wins on concurrent
  add+remove); discard wipes only events it causally observed.
- Browser: `src/companion/outbox.ts` (generic, with
  `reject-when-full` overflow for user-authored content) +
  `src/review/draftClient.ts` (HTTP client) +
  `src/review/outbox.ts` (review-draft outbox). Each mutation in
  `state.ts` reads the per-thread `vector` from chrome.storage and
  ships it as `baseVector` on the outbound `ClientEvent`.
- Conflict UI: `ReviewDraftFooter.tsx` renders a picker per
  conflicted register; click → mints a normal mutation; the next
  projection collapses back to `resolved` because `baseVector`
  covers all candidate dots.

### PR 2 — Recall consistency

Wires recall to the same event substrate.

- `src/recall/recovery.ts` — startup PID lock + orphan `.tmp` cleanup.
- `src/recall/lifecycle.ts` — single-writer `Mutex` serialising
  rebuild / `appendEntry` / `gcEntries` / `tombstoneByThread`.
  Drift detection (`entryCount < eventTurnCount × (1 − tolerance)`).
- `src/recall/events.ts` — `capture.recorded`,
  `recall.tombstone.target`.
- `src/recall/projection.ts` — `projectRecallFromLog(events)` →
  `RecallProjectionInput[]` (deterministic; tombstone-aware).
- `POST /v1/events` dual-writes to legacy `_BAC/events/` AND the
  per-replica log; rebuild reads both, deduped by `bac_id`.
- `lifecycle.tombstoneByThread` emits a `recall.tombstone.target`
  event AND mutates the index immediately.

### PR 3 — More aggregates as causal projections

Each follows the same recipe (events + projection +
dual-write + projection-read route):

| Aggregate | Module | Notes |
|---|---|---|
| Threads | `src/threads/` | Full-record register over the whole thread; status sub-register; delete is observed-tombstone (concurrent later upserts revive). |
| Workstreams | `src/workstreams/` | Full-record register; PATCH route reads the just-written JSON and emits a complete snapshot. Per-field registers (parentId/privacy/tags) are documented future work. |
| Queue items | `src/queue/` | Base record from the first creation event + status sub-register. |
| Dispatches | `src/dispatches/` | Append-only fact list; per-dispatch link is LWW (`mergeRegister`) on `dispatchId → threadId`. |
| Annotations | `src/annotations/` | Anchor + URL captured on creation; note is a register; delete is observed-tombstone. |

### PR 4 — Optional E2E-encrypted relay

A pure transport — never durable storage — for replicas without a
shared filesystem.

- `src/sync/relayCrypto.ts` — HKDF-SHA256 derives `rendezvous_id`
  (16 B routing tag) + `rendezvous_key` (32 B AEAD key) from a
  shared secret. AES-256-GCM with `AAD = rendezvous_id ||
  sender_replica_id` binds ciphertext to its routing tags. Per-
  replica Ed25519 keypair signs `replicaId || lamport_be64 ||
  payload`. `ReplayCache` keeps the last 1024 nonces per sender.
  Built only on Node native crypto — no third-party crypto deps.
- `src/sync/relayProtocol.ts` — JSON frames over WebSocket binary:
  `HELLO`/`WELCOME`/`SUBSCRIBE`/`PUBLISH`/`EVENT`/`PING`/`PONG`/
  `ERROR`. Binary fields are base64url. (Switching to CBOR is a
  wire-format swap; semantics don't change.)
- `src/sync/relayServer.ts` — bounded ring buffer per rendezvous
  (≤1000 events / ≤100 MB / ≤24 h, oldest dropped). Per-rendezvous
  rolling rate limit. No durable storage; restart wipes every
  rendezvous. Exposed as `sidetrack-companion relay --relay-port
  8443` — front with a TLS reverse proxy for `wss://`.
- `src/sync/relayTransport.ts` — replaces the PR1 stub. On publish:
  JSON-encode the `AcceptedEvent`, sign, AEAD-seal, send PUBLISH.
  On EVENT: replay-cache check, AEAD-open, signature-verify against
  the embedded public key, validate decrypted payload's
  `dot.replicaId` matches the sender, dispatch.
- Companion CLI: `--sync-relay <wss://...>` +
  `--sync-rendezvous-secret <base64url>`. `runtime/companion.ts`
  decorates `eventLog.appendClient` to publish accepted events via
  the relay; subscribes to incoming peer events and routes them to
  `eventLog.importPeerEvent` (which persists under
  `_BAC/log/<peerReplicaId>/...`).

## Storage layout

```
_BAC/
  .config/
    replica-id                      # UUID v4 per host
    replica-seq                     # monotonic per-replica counter
    replica-keypair.json            # Ed25519 keys (PR4 only)
    bridge.key                      # existing
  log/
    <replicaId>/<YYYY-MM-DD>.jsonl  # per-replica AcceptedEvent shards
  events/                           # legacy capture log (kept; PR2 dual-writes)
  recall/
    index.bin                       # rebuildable cache; binary V2
    .lock                           # single-writer PID lock
  threads/<bac_id>.json             # legacy + dual-write
  workstreams/<bac_id>.json         # legacy + dual-write
  queue/...                         # legacy + dual-write
  dispatches/...                    # legacy + dual-write
  annotations/...                   # legacy + dual-write
  review-drafts/<threadId>.json     # PR1 projection snapshot
```

Each replica writes only inside its own log subdirectory.
File-syncing tools (Syncthing) pointed at `_BAC/log/` ferry shards
between replicas without write conflicts.

## Critical correctness rules

1. **`deps` come from `baseVector` verbatim.** When the companion
   accepts a stale outbox event from a long-disconnected browser, it
   MUST NOT bump `deps` to its current frontier. Doing so would
   falsely claim the editor observed peer events they never saw.
   Test: `eventLog.test.ts > stamps deps from the client baseVector
   verbatim …`.
2. **Idempotent on `clientEventId`.** Retrying a request returns the
   *same* AcceptedEvent (same dot, same `acceptedAtMs`). Test:
   `eventLog.test.ts > idempotent retry returns the same
   AcceptedEvent …`.
3. **User-authored outboxes do not silently drop.** Capture queue
   uses `drop-oldest` (telemetry); review-draft outbox uses
   `reject-when-full` so a comment never silently disappears.
4. **HLC is advisory.** It can sort conflict candidates in the UI or
   suggest auto-resolve when clocks are trusted. It MUST NOT decide
   correctness; that is `dot` + `deps`.

## Conflict UX

Projections expose conflict status explicitly:

```ts
{ status: 'conflict', candidates: [{ value, event, replicaId, acceptedAtMs }] }
```

The side panel renders a picker. The user's pick mints a normal
mutation whose `baseVector` is the projection's `vector` (i.e.
covers every candidate dot). Resolution converges everywhere on the
next sync.

## Verification

- `cd packages/sidetrack-companion && npm test` — 287 unit tests
  pass, 1 skipped. Includes the two-replica simulation
  (`twoReplica.test.ts`) using `cp` to ferry log shards between two
  `mkdtemp` vaults; concurrent edits surface as conflict; manual
  merge resolves on both sides.
- `cd packages/sidetrack-extension && npm test` — 244 unit tests
  pass.
- Live smoke (manual):
  - `sidetrack-companion --vault <path>` emits the replica id once
    (printed on first start under `replica id`).
  - With `--sync-relay <wss://...> --sync-rendezvous-secret <b64u>`
    on two hosts pointed at the same relay (`sidetrack-companion
    relay`), an inline-review comment on host A appears on host B
    within ~1 s.

## Trade-offs and follow-ups

- **CBOR vs JSON wire format.** The relay protocol uses JSON
  initially. CBOR is a future optimisation; semantics don't change.
- **Per-field registers for workstreams.** Today the projection
  takes the whole record as a single register; PATCH rebuilds a
  full snapshot. Concurrent edits to *different* fields conflict
  (one event wins entire). Per-field registers are documented as
  follow-up work.
- **IndexedDB-backed outbox.** The browser outbox sits on
  chrome.storage with `reject-when-full` (cap 10 000). The branch-2
  spec lists IndexedDB as the preferred backing; the current
  implementation is the "acceptable" tier.
- **Hosted relay deployment.** The `sidetrack-companion relay`
  binary runs anywhere Node 22+ runs (Fly.io, Railway, a VPS); a
  prescribed deployment recipe is not part of this PR.
- **Side-panel rendezvous setup UI.** Only the CLI flag is wired
  today; a Settings → Sync section in the side panel is follow-up
  work.

## Why event-sourced + CRDT, not Dropbox-of-the-vault

Today's vault has three classes of write — all of which corrupt on
direct file-sync:

- Append-only JSONL (`_BAC/events/`, dispatches, audit, reviews).
  Two replicas writing the same day → last-renamer-wins on
  disk-syncing tools, lost lines.
- Atomic JSON (`_BAC/threads/<id>.json`). Last-writer-wins
  overwrites the other replica's edit.
- Binary index (`_BAC/recall/index.bin`). Full rewrite per upsert.
  Two writers → guaranteed corruption.

Per-replica logs + deterministic projections side-step every one of
those. File syncing is now safe because each replica only writes
inside its own subdirectory.
