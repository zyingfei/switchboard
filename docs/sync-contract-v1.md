# Sync Contract v1

This document describes the architectural model that every sync surface
in the system must satisfy. Read this first if you are adding a new
event type, a new derived projection, a new query endpoint, or any
state that needs to converge across replicas.

## TL;DR

- Every accepted event — local OR peer — enters one runner, dispatches
  to a fixed set of materializers, and updates one or more derived
  surfaces with declared freshness/recovery promises.
- Every surface belongs to exactly one of six **classes** (A/B/C/D/E/F).
  The class is the surface's entire promise: convergence, freshness,
  recovery, and storage rules follow from it.
- Three operating modes — **P** (plugin alone), **P+C** (plus companion),
  **P+C+R** (plus relay) — each support a documented degraded subset of
  the contract. No layer assumes the layer above it is available; no
  layer assumes the layer below it has infinite storage.
- Correctness is **replay-recoverable**. Notifications between
  materializers accelerate convergence; they never gate it.

If you only remember one thing: **register the event in the contract
registry, write the materializer to be idempotent + coalesced +
replayable, and add a gate test.** The rest of this document is the
why.

## Architecture

```text
plugin active edge state
  → companion durable / materialized state
  → optional relay / sync state

event log truth
  → contract runner (local + peer accepted events, symmetric)
  → materializers (projection, recall, extraction, … future)
  → health + gate tests

source observation (capture, future timeline, …)
  → versioned extraction revisions (Class E)
  → recall / context-pack / Obsidian / MCP / future consumers (Class B)
```

Source of truth flows top-to-bottom:

```text
capture / source observation events  (immutable; the event log)
        │
        ▼
extraction revisions (Class E; versioned, replaceable, syncable)
        │
        ▼
downstream consumers — recall (Class B), context-pack, Obsidian,
                       citations, MCP, future surfaces
        │
        ▼
plugin-tier bounded windows (Class F; what the user sees right now)
```

## Invariants

These are non-negotiable. Every materializer, projection, and query
endpoint upholds them:

```
1.  No layer assumes the layer above it is available.
2.  No layer assumes the layer below it has infinite storage.
3.  Every accepted event, local or peer, enters the executable
    contract.
4.  Browser-observed deps are never replaced by companion-observed
    deps. Empty browser-observed baseVector `{}` is valid and means
    "observed nothing."
5.  Every derived surface has an owner, freshness bound, recovery
    path, and health signal.
6.  Extraction revisions are the canonical evolving interpretation
    layer.
7.  Recall is a cache over active extraction revisions.
8.  Plugin active state is bounded but self-sufficient.
9.  Plugin extended history is companion-backed or archive-backed.
10. Callbacks accelerate correctness; replay/catch-up restores
    correctness.
11. Archive export is a handoff, not guaranteed sync.
12. Edge archive identity is single-source-of-truth: a real edge
    replica id, not a dual edge/companion identity.
```

The contract runner + materializer interface enforce 3, 5, 8, 9, and 10.
The append-API split enforces 4. The extraction store enforces 6 and 7.
The Class F primitives enforce 8 and 11. The edge replica id enforces
12.

## Six classes

Class is **per surface**, not per event. One event can touch multiple
surfaces in different classes — `capture.recorded` writes to Class E
(extraction revision), Class B (recall index), and Class C (capture
audit JSONL) all from one accepted event.

| Class | Examples | Convergence | Freshness | Recovery | Plugin tier behavior |
|---|---|---|---|---|---|
| **A — Aggregate projection** | thread, workstream, queue, dispatch, dispatch-link, annotation, review-draft | Causal CRDT (LWW + tombstones over dots) | < 5 s normal; < 30 s post-reconnect | reproject from event log + projection materializer catch-up | bounded active set + bounded spool + optional archive export |
| **B — Derived cache** | recall index | Causal CRDT (via active extraction revisions) | < 30 s normal | replay event log + active extraction revisions; source-scoped re-extract for upgrades | bounded active-window for plugin search; companion-backed extended queries |
| **C — Local-only state** | capture audit JSONL, dispatch JSONL, markdown sidecars, selector health, side-panel preferences | n/a | n/a | per-replica restart | local-only by definition; never spooled or synced |
| **D — Identity / auth** | bridgeKey, replicaId, replica key pair, edgeReplicaId | n/a | n/a | bootstrap-once persisted | per-tier bootstrap (browser bootstraps edge id once per profile) |
| **E — Versioned extraction revisions** | chatgpt / claude / gemini turn extractions, normalized turn records, citation / attachment / modelName enrichment | Causal CRDT (extraction events) + deterministic active-revision policy | < 30 s after newer revision arrives | source-scoped re-extract; never full rebuild for ordinary upgrades | active-revision content for active window; companion-backed extended history |
| **F — Plugin-tier bounded storage** | active threads / queue / dispatch / recall / capture queue / future timeline windows | Plugin-local; reconciled when companion reachable | sub-second local; bounded by per-tier budgets | local-only fallback in Mode P; companion drains spool when online; optional archive export | three sub-tiers below: active set / local spool / archive export |

The complete mapping from event types to surfaces lives in the
contract registry at
`packages/sidetrack-companion/src/sync/contract/registry.ts` and is
verified by `registry.test.ts` (gate L1-G1).

## Operating modes

The contract holds in each mode. Mode transitions are observable.

### Mode P — plugin alone

Companion unreachable.

**What holds:**

- **Explicit user actions** (capture button, dispatch send, queue
  follow-up, annotation save, …) are admitted if the plugin's active
  set / spool has capacity. If capacity is exhausted the action is
  **visibly rejected** with recovery instructions. Never silently
  dropped.
- **Passive observations** (auto-track, timeline, …) may be sampled,
  dropped, summarized, or archived by policy. Policy choice is
  health-visible.
- Side panel renders Class F active windows. Always responsive,
  bounded.
- Recall query falls back to active-window lexical search (no companion
  embeddings).
- Mode-down is observable in the side panel header + audit log.

**What does NOT hold:**

- Cross-replica sync.
- Full recall (only active-window chunks).
- Extended Class E history (only active extraction revisions for
  the active window).

Query results in Mode P are marked with `ResultScope`:
`plugin-active` or `plugin-active-only-companion-unreachable`. The UI
must render the scope honestly — no silent truncation.

### Mode P+C — plugin + companion, no relay

**What holds:** everything in Mode P, plus

- Plugin spool drains to companion. Drains are idempotent on the
  edge dot, so partial-drain crashes resume safely.
- Companion runs all materializers (projection, recall, extraction,
  any future ones).
- Plugin's Class F active windows reflect companion state via SSE +
  chrome.storage mirror.
- Plugin extended queries hit companion HTTP and return
  `companion-extended`.

**What does NOT hold:** cross-replica sync.

### Mode P+C+R — full sync

**What holds:** everything above, plus

- All Class A / B / E surfaces converge across replicas per their
  freshness bounds.
- Companion-side `runner.onRelayReconnected(eventLog)` AWAITS every
  materializer's catch-up after every reconnect. No false-pass at
  reconnect.

## Materializer contract

A materializer owns one or more derived surfaces. It implements:

```ts
interface Materializer {
  readonly name: string;
  readonly handles: ReadonlySet<string>;

  // Dispatched per accepted event (local OR peer).
  // MUST coalesce internally. Returns synchronously.
  readonly onAccepted: (event: AcceptedEvent, ctx: { origin: 'local' | 'peer' }) => void;

  // Replay-from-log. RESOLVES ONLY AFTER current drain is complete.
  // Materializers that depend on other materializers' durable state
  // MUST scan that state here — never rely on a callback that may
  // have been missed across a crash.
  readonly catchUp: (eventLog: EventLog) => Promise<void>;

  readonly awaitIdle: () => Promise<void>;
  readonly health: () => MaterializerHealth;
}
```

Required properties (each enforced by tests):

1. **Idempotent.** `onAccepted(e)` then `catchUp(log)` ≡ `catchUp(log)`
   alone.
2. **Coalesced.** A burst of N events for the same surface schedules
   at most one in-flight worker. Pattern: dirty bit + single drainer,
   or per-key promise queue.
3. **Replayable.** State is a pure function of event log + the
   materializer's own durable state. No state lives in memory only.
4. **Independently failing.** Throws update health; never bubble out
   of `onAccepted`/`catchUp` into other materializers. The runner
   swallows.
5. **Health-visible.** `health()` is consumed by `/v1/system/health`.
6. **Local-vs-peer symmetric.** Both origins produce the same
   observable derived state (gate L1-G10). A materializer MAY no-op
   for `origin: 'local'` if another path already wrote the surface
   (e.g. flat file via `vault/writer.ts`), but the choice must be
   explicit and tested.
7. **Startup + reconnect AWAIT drain.** `runner.catchUpAll` and
   `runner.onRelayReconnected` AWAIT each materializer's `catchUp`.
   Fire-and-forget catch-up is forbidden — startup tests rely on
   AWAITED resolution to assert "contract restored."
8. **Callback-independent correctness.** If materializer X notifies
   consumer Y, Y MUST also independently scan durable state in its
   own `catchUp`. Notifications accelerate; replay restores.

### Why callback-independent correctness matters

The motivating bug: extraction materializer updates
`latestExtractionRevision`; before it can notify recall, the process
crashes; on restart, recall has no in-memory notification waiting and
its index is now stale.

Resolution: recall's `catchUp` reads the extraction store directly,
detects `latestExtractionRevision != indexedExtractionRevision`, and
calls `replaceEntriesForSourceUnit`. The notification is an
optimization; durable state is the truth (gate L2-G10).

## Causal rules

The event log exposes two append APIs:

```ts
interface EventLog {
  // Browser-driven events. baseVector REQUIRED. Empty `{}` is VALID
  // and means "browser observed nothing." Companion NEVER substitutes
  // its current frontier.
  appendClientObserved: <T>(input: AppendInputObserved<T>) => Promise<AcceptedEvent<T>>;

  // Server-driven mutations (archive, delete, recall tombstone,
  // dispatch.linked, capture.extraction.produced from local re-extract,
  // capture.recorded from a local plugin POST). Companion stamps deps
  // from the aggregate's current frontier. The ONLY API allowed to
  // use frontier.
  appendServerObserved: <T>(input: AppendInputServerObserved<T>) => Promise<AcceptedEvent<T>>;

  importPeerEvent: (event: AcceptedEvent) => Promise<{ readonly imported: boolean }>;
}
```

**The invariant** (#4 above):

> Browser-observed deps are never replaced by companion-observed deps.

Concretely: a stale browser outbox event with `baseVector: {}` is
**accepted as concurrent** to any peer events that arrived at the
companion in between. The projection treats it as concurrent — it does
NOT dominate the peer events. (Gate L1-G7. Reject-on-empty was the
wrong invariant.)

## Health rules

Convergence at the event-log layer is necessary but not sufficient.
A materializer can be silently stuck while every event is durably
appended.

`/v1/system/health` exposes `sync.materializers.<name>` for every
registered materializer:

```json
{
  "sync": {
    "materializers": {
      "recall":     { "status": "healthy",  "lastSuccessAt": "...", "pending": false },
      "projection": { "status": "healthy",  "lastSuccessAt": "...", "pending": false },
      "extraction": { "status": "degraded", "lastSuccessAt": "...", "pending": true  }
    }
  }
}
```

`status` is one of `healthy | degraded | failed`. `failed` means the
last attempt threw and `lastError` carries the message; the next
event or the next `catchUp` will retry.

Materializer failures are health-visible by design. The runner does
not retry them automatically — it surfaces the failure and lets the
next event or the next reconnect drive recovery. This keeps the
failure mode legible.

## Path ownership

For Class A aggregates that have both a flat legacy file and a sync
projection envelope:

```
_BAC/threads/<id>.json                 ← flat shape
                                         vault/writer.ts; legacy readers
                                         (parseThreadUpsertBody, …);
                                         local-action concerns (markdown
                                         sidecar, audit JSONL)
_BAC/threads/projections/<id>.json     ← projection envelope
                                         projection materializer for BOTH
                                         local AND peer origins; SSE
                                         prefix; consumed by extension
                                         mirror + side panel
```

Side panel + API consumers read **either** the projection path
directly **or** an HTTP endpoint that abstracts the source. They never
parse flat files in some cases and projection envelopes in others
(gate L1-G8).

## Gate list

29 gates across three lanes verify the contract:

- **Lane 1 (Sync Contract Core):** L1-G1 .. L1-G10
- **Lane 2 (Extraction Revisions):** L2-G1 .. L2-G10
- **Lane 3 (Plugin Edge Storage):** L3-G1 .. L3-G9

Each gate has a stable id and a corresponding test file. Highlights:

- **L1-G1** — Registry coverage. Every event type in `*/events.ts` has
  exactly one registry entry; no orphan materializers.
- **L1-G7** — Stale outbox accepted as concurrent. `baseVector: {}`
  arriving after peer events drained does not dominate them.
- **L1-G10** — Local + peer symmetric materialization. The same
  surface ends up byte-shape-compatible regardless of origin.
- **L2-G2** — Embedding cache reuse. Metadata-only extractor upgrade
  reuses vectors when the embedder input (`chunk.embedText`) is
  unchanged.
- **L2-G10** — Replay-recoverable extraction → recall. A crash between
  the extraction update and recall's notification recovers correctly
  via recall's `catchUp` scan of the extraction store.
- **L3-G2** — Bounded spool. Active overflow goes to spool; spool
  overflow either exports or visibly rejects per intent + capacity.
- **L3-G7** — Archive identity. Same archive imported twice is
  idempotent on edge dot; same archive imported by two companions
  produces no duplicate logical events.

The full lane structure and gate descriptions are in the project's
plan documents (`AGENTS.md` references the canonical plan). Tests
live alongside the code they exercise:
`packages/sidetrack-companion/src/sync/contract/*.test.ts` for Lane
1 + 2 unit gates, `tests/e2e/cross-replica-recall.spec.ts` for the
real two-companion + relay e2e.

## Adding a new sync surface

See [`adding-a-sync-surface.md`](adding-a-sync-surface.md). Timeline
is the worked example.
