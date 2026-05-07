# Adding a sync surface

This is the contributor recipe for adding a new event-driven surface
to the system. Follow it and your surface plugs into the contract
runner, projection materializers, plugin-tier budgeting, registry
coverage, and health endpoints — without inventing new mechanisms.

Read [`sync-contract-v1.md`](sync-contract-v1.md),
[`extraction-revisions.md`](extraction-revisions.md), and
[`plugin-edge-storage.md`](plugin-edge-storage.md) first.

The browser timeline feature is the worked example throughout. See
[`timeline.md`](timeline.md) for its product shape; this doc focuses
on the recipe.

## The 10 steps

```
1.  Pick a class (A / B / C / D / E / F).
2.  Define the event type(s).
3.  Add a contract registry entry.
4.  Add a companion materializer if the surface is companion-visible.
5.  Add a plugin materializer if the surface is plugin-tier-visible.
6.  Define freshness, recovery, health.
7.  Add a catchUp / replay path.
8.  Add unit tests.
9.  Add a user-outcome e2e test if the surface is user-visible across
    replicas.
10. Add ResultScope behavior if a query/search can be partial.
```

Each step below cross-references how timeline applies it.

## 1. Pick a class

The class determines convergence, freshness, recovery, and storage
rules. Use this decision tree:

- "Multiple replicas write the same logical record (one thread, one
  workstream, one queue item, one annotation, …)" → **Class A**
  (aggregate projection).
- "I'm building a search index / cache / view that derives from
  events" → **Class B** (derived cache).
- "This is per-replica state that nobody else cares about (audit
  log, sidecar, preferences)" → **Class C** (local-only).
- "This is identity/auth/keys" → **Class D**.
- "This is an evolving interpretation of source observations
  (extractor, normalizer)" → **Class E** (extraction revision).
- "This is plugin-tier user-facing state with bounded storage" →
  **Class F**.

A surface CAN belong to multiple classes if it has multiple legs.
`capture.recorded` writes to E (extraction revision), B (recall
index), and C (audit JSONL) all from one event.

**Timeline:** mainly Class F (plugin-tier active window of recent
observations). The companion-side projection of timeline entries is
Class B (derived cache — a deterministic daily reduction over
events; no per-record concurrent-edit semantics, so it isn't
Class A). Optional later: a Class B recall-style semantic index
if needed.

## 2. Define the event type(s)

Pick names that describe **what was observed**, not what surface
should react. Past tense, namespaced by domain:

```
✅ capture.recorded
✅ thread.upserted
✅ annotation.created
✅ browser.timeline.observed

❌ recall.index.update.requested        (verb-y, surface-specific)
❌ on-tab-change                         (action-y, not observation)
```

Define the payload as a `readonly interface` and a runtime predicate
in `<surface>/events.ts`:

```ts
// packages/sidetrack-companion/src/timeline/events.ts
export const BROWSER_TIMELINE_OBSERVED = 'browser.timeline.observed';

export interface BrowserTimelineObservedPayload {
  readonly eventId: string;
  readonly observedAt: string;
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly provider?: 'chatgpt' | 'claude' | 'gemini' | 'generic';
  readonly transition: 'activated' | 'updated' | 'completed' | 'closed';
  readonly tabIdHash?: string;
  readonly windowIdHash?: string;
}

export const isBrowserTimelineObservedPayload = (
  value: unknown,
): value is BrowserTimelineObservedPayload => { /* runtime check */ };
```

Both companion and plugin import the constant; tests use the
runtime predicate to validate fixtures.

## 3. Add a contract registry entry

Edit
`packages/sidetrack-companion/src/sync/contract/registry.ts` and add
one `ContractEntry` per event type. Each entry's `surfaces[]` lists
**every** surface this event touches — across all classes — with the
class, materializer, freshness bound, and recovery mode for each.

```ts
{
  eventType: BROWSER_TIMELINE_OBSERVED,
  surfaces: [
    {
      surface: 'plugin-timeline-active-window',
      class: 'plugin-tier-bounded',
      recovery: 'spool-drain',
    },
    {
      surface: 'timeline-projection',
      class: 'aggregate-projection',
      materializer: 'projection',     // OR a dedicated 'timeline' materializer
      peerFreshnessMs: 30_000,
      recovery: 'replay-event-log',
    },
  ],
},
```

If you introduce a new materializer name, add it to
`KNOWN_MATERIALIZERS`. The registry coverage test (`registry.test.ts`,
gate L1-G1) asserts:

- every event type in `*/events.ts` has exactly one entry;
- every `materializer` field references a known materializer;
- Class-A surfaces route to the projection materializer;
- Class-E surfaces route to the extraction materializer;
- Class-B surfaces have a valid recovery mode;
- no entry has an empty `surfaces[]`;
- no two entries share an `eventType`.

A failing registry test is the first signal of a forgotten event.

## 4. Companion materializer (if companion-visible)

If the surface lives in the companion vault (`_BAC/...`), implement a
`Materializer`:

```ts
// packages/sidetrack-companion/src/sync/contract/timelineMaterializer.ts
export const createTimelineMaterializer = (deps: { ... }): Materializer => {
  const handles = eventTypesForMaterializer('timeline'); // pulls from registry
  let pending = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  // ... dirty bit OR per-key promise queue ...

  return {
    name: 'timeline',
    handles,
    onAccepted: (event, _ctx) => { /* coalesced schedule */ },
    catchUp: async (eventLog) => { /* AWAIT drain */ },
    awaitIdle: async () => { /* wait for pending=false */ },
    health: () => ({ status, lastSuccessAt, lastError, pending }),
  };
};
```

Properties (asserted by tests):

1. **Idempotent.** `onAccepted(e)` then `catchUp(log)` ≡ `catchUp(log)`
   alone.
2. **Coalesced.** Burst → exactly one in-flight worker.
3. **Replayable.** State is a pure function of event log + the
   materializer's own durable state.
4. **Independently failing.** Throws update health; never bubble.
5. **Health-visible.** Surfaced via `/v1/system/health`.
6. **Local-vs-peer symmetric.** Both origins produce the same
   observable derived state.
7. **`catchUp` AWAITS drain.** Resolves only after the first drain
   pass completes.
8. **Callback-independent correctness.** If you depend on another
   materializer's durable state, `catchUp` MUST scan it.

Register the materializer with the runner in
`packages/sidetrack-companion/src/runtime/companion.ts`:

```ts
syncContractRunner.register(createTimelineMaterializer({ ... }));
```

If your projection slot can be served by the existing projection
materializer (most Class A surfaces), reuse it instead of writing a
new materializer.

## 5. Plugin materializer (if plugin-tier-visible)

If users see this surface in the side panel (Class F), wrap it as a
`PluginMaterializer<TItem>`:

```ts
// packages/sidetrack-extension/src/timeline/materializer.ts
export const timelinePluginMaterializer: PluginMaterializer<TimelineEntry> = {
  name: 'timeline',
  admitLocal: async (item, intent) => { /* budget guard + spool */ },
  mirrorFromCompanion: async (item) => { /* SSE-driven mirror */ },
  fetchExtended: async (query) => { /* HTTP fallback + ResultScope */ },
  drainSpoolToCompanion: async () => { /* idempotent on edgeDot */ },
  exportSpoolToArchive: async () => { /* chrome.downloads */ },
  health: () => ({ ... }),
};
```

Use the existing primitives — don't invent new ones:

- `PluginBudgetGuard` for admit/reject decisions.
- `spool*` functions from `spool.ts` for state-machine transitions.
- `loadOrCreateEdgeReplica` + `allocateNextSeq` for edge dots.
- `buildScopedResult` for query results.

Register in `PLUGIN_MATERIALIZERS` in
`packages/sidetrack-extension/src/sync/mirrorMaterializers.ts` (or
its successor) so the side panel iterates uniformly.

## 6. Define freshness, recovery, health

Three numbers that go in the registry entry and the materializer's
`health()`:

- **Freshness bound** (`peerFreshnessMs`) — under normal operation,
  how long after a peer event lands before this surface reflects it?
  Typical values:
    - Class A projections: 5_000 ms
    - Class B / E surfaces: 30_000 ms
    - Class F mirror: bounded by SSE delivery, sub-second
- **Recovery mode** (`recovery`) — pick one:
    - `replay-event-log` — read every relevant event in the merged
      log and produce the surface deterministically.
    - `source-scoped-reextract` — Class B + Class E pattern; rebuild
      one source at a time.
    - `on-demand-rebuild` — surface is built when a query asks for
      it (annotation overlay).
    - `spool-drain` — Class F surfaces; recovery is "wait for
      companion + drain."
    - `none` — Class C / D; per-replica restart is enough.
- **Health signal** — `MaterializerHealth` (companion) or
  `PluginMaterializerHealth` (plugin).

If you cannot pick clean values for these three, the surface is not
ready to register — the contract requires them.

## 7. Add a catchUp / replay path

Crash recovery and reconnect drain both go through `catchUp`. Two
shapes:

**Pure event-log replay** (most projections):

```ts
catchUp: async (eventLog) => {
  const merged = await eventLog.readMerged();
  for (const event of merged.filter((e) => handles.has(e.type))) {
    await applyToProjection(event);
  }
}
```

**Cross-materializer recovery** (recall reading extraction store):

```ts
catchUp: async (eventLog) => {
  // 1. Replay log for events I directly handle.
  await drain();
  // 2. Independently scan upstream materializer's durable state.
  //    Notifications may have been missed across a crash.
  for (const stale of await otherStore.listStaleSources()) {
    await reconcile(stale);
  }
}
```

The cross-materializer pattern is what makes the contract
**callback-independent**. The notification accelerates; the scan
restores correctness (gate L2-G10).

## 8. Add unit tests

For a companion materializer:

- `onAccepted(e)` then `catchUp(log)` ≡ `catchUp(log)` alone
  (idempotency).
- Burst of N events → exactly one in-flight worker (coalescing).
- Throw in `onAccepted` updates health to `failed`, doesn't bubble
  (independent failure).
- Crash mid-drain + restart's `catchUp` recovers (replay).
- Local + peer origins produce the same observable surface
  (symmetry).
- Concurrent same-key events serialize correctly (per-key queue).

For a plugin materializer:

- `admitLocal` returns < 50 ms regardless of companion reachability.
- Active overflow → spool transition (gate L3-G2).
- Explicit overflow → `failed-explicit` (visible rejection).
- Passive overflow → `dropped-passive-by-policy` (health counter).
- Spool drain is idempotent on edge dot (gate L3-G5).
- `fetchExtended` returns the correct `ResultScope` per mode.

Tests colocate next to the implementation (`*.test.ts` next to
`*.ts`).

## 9. Add a user-outcome e2e (if user-visible across replicas)

If two browsers using the same vault should agree on this surface,
add an e2e test in `packages/sidetrack-extension/tests/e2e/`:

```ts
// Pseudocode shape:
const companionA = await spawnCompanion({ vault: vaultA, port: portA });
const companionB = await spawnCompanion({ vault: vaultB, port: portB });
const relay = await spawnRelay({ port: relayPort });
// connect both companions to the relay
// drive the user-visible action in browser A (HTTP POST or Playwright)
// assert the surface lands in browser B within freshness bound
```

The existing `cross-replica-recall.spec.ts` is the template:
two real companion subprocesses, real relay, real HTTP. The test
embedder gate (`SIDETRACK_TEST_EMBEDDER=1`) keeps recall e2e fast.

For passive observations, e2e usually isn't needed — unit + contract
tests cover the user-visible behavior. Use e2e only when there is a
**user-outcome** assertion that cannot be expressed at lower layers.

## 10. ResultScope (if queries can be partial)

Any query endpoint that can return less than "everything you'd see
with full sync" must return a `ScopedResult<T>`:

```ts
{
  scope: 'plugin-active' | 'companion-extended'
       | 'plugin-active-only-companion-unreachable'
       | 'archive-exported-not-imported',
  items: [...],
  note?: string,
}
```

Use `buildScopedResult(scope, items)` to attach the right note for
the side panel to render.

A query that ALWAYS returns the full set (e.g. fetch one specific
record by id from the projection store) doesn't need a scope. A query
that searches, paginates, or windows by time DOES.

## Worked example: timeline

Applying the recipe to timeline (full design in
[`timeline.md`](timeline.md)):

1. **Class.** Plugin-tier active window is Class F. Companion-side
   projection of entries is Class B (derived cache).
2. **Event.** `browser.timeline.observed`. Payload covers
   activate/update/complete/close transitions; URL +
   canonical URL + title + provider; tabId/windowId hashes
   (privacy: hashed, not raw).
3. **Registry entry.** Two surfaces:
   `plugin-timeline-active-window` (F, recovery `spool-drain`) and
   `timeline-projection` (B, materializer `timeline`,
   freshness 30_000 ms, recovery `replay-event-log`).
4. **Companion materializer.** Dedicated `timeline` materializer
   that writes daily-bucketed projection files at
   `_BAC/timeline/projections/<YYYY-MM-DD>.json`. Registered in
   `KNOWN_MATERIALIZERS`.
5. **Plugin materializer.** New `timelinePluginMaterializer`. Active
   set capped per `activeSetCount.timeline`. Passive intent (default).
   Spool overflow → drop-by-policy with health counter.
6. **Freshness / recovery / health.** Plugin: sub-second within
   active window. Companion: 30 s after peer event. Recovery: log
   replay (Class A) + spool drain (Class F).
7. **catchUp.** Companion projection materializer replays
   `browser.timeline.observed` from the merged log into
   daily-bucketed files. Plugin reconciles active set + spool counts
   from `chrome.storage`.
8. **Unit tests.** Observer debounce, projection determinism, active
   overflow → spool, passive overflow → drop, drain idempotency.
9. **e2e.** Mode P offline timeline observed → Mode P+C drain → GET
   `/v1/timeline` returns the drained entries.
10. **ResultScope.** Plugin local query returns `plugin-active` (or
    `plugin-active-only-companion-unreachable`). Extended query
    against companion returns `companion-extended`.

That's it. The architecture takes care of dispatch, recovery, and
health; the recipe is what you fill in.

## Smell tests

If your design hits any of these, stop and reconsider:

- **"My surface needs a notification from another surface to stay
  correct."** No — make `catchUp` scan the upstream durable state.
  Notifications accelerate; replay restores.
- **"My event handler needs to write to chrome.storage and POST to
  the companion."** Pick one. Plugin emits the event; the
  PluginMaterializer admits to active/spool; the spool drainer POSTs.
  No surface owns both.
- **"My passive observation must not be dropped."** Then it isn't
  passive — re-classify it as explicit and live with the visible
  rejection on overflow. Most "must not drop" instincts are wrong;
  storage is bounded.
- **"My new materializer needs to read its own state machine to
  decide what to do."** Fine, but make sure that state machine is
  durable and `catchUp`-recoverable. In-memory state must be
  reconstructable from disk.
- **"I'll just call `lifecycle.ingestIncremental` directly from the
  HTTP handler."** No. The runner is the single dispatch point.
  Local accepted events route through
  `appendServerObserved` → runner → recall materializer. (This was
  the bug PR #96 closed.)
