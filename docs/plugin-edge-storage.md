# Plugin edge storage (Class F)

The browser plugin is the **edge** of the system. It is bounded — it
runs inside `chrome.storage.local`, which has a hard quota — and it
must be self-sufficient when the companion is unreachable. Class F is
the contract that makes both true at once.

Read [`sync-contract-v1.md`](sync-contract-v1.md) first.

## Three sub-tiers

```text
active set       — rendered + locally searchable
local spool      — bounded queue of items pending companion drain or
                   archive export
archive export   — file/pack handoff via chrome.downloads, NOT
                   guaranteed sync
companion store  — extended history + larger indexes
```

`chrome.storage.local`'s 10 MB quota is divided across surfaces. Each
surface has its own active-set count cap and shares the spool budget.
Defaults from
`packages/sidetrack-extension/src/sync/budgetConfig.ts`:

```ts
DEFAULT_PLUGIN_BUDGETS = {
  activeSetBytes: 4_500_000, // ~4.5 MB
  activeSetCount: { threads: 200, workstreams: 100, queue: 100,
                    dispatches: 50, annotations: 100 },
  spoolBytes: 2_000_000,
  spoolCount: 1_000,
  maxExplicitPending: 200,
  maxPassivePending: 800,
  archiveExportTriggerBytes: 1_500_000,
};
```

These are conservative: a heavy user fits within them and the plugin
keeps headroom for future surfaces (timeline, summaries, …).

## Item state machine

Every Class F item moves through this state machine:

```text
 active ──overflow──▶ pending-send ──companion-ack──▶ evicted-after-ack
                            │
                            └─overflow w/o ack──▶ spooled
                                                    │
                                                    └─spool overflow
                                                      / long-offline──▶ exported
                                                                          │
                                                                          └─companion-import──▶ companion-imported

 terminal: failed-explicit            (visible rejection — never silent)
           dropped-passive-by-policy  (health-visible counter)
```

States from `packages/sidetrack-extension/src/sync/spool.ts`:

| State | Meaning |
|---|---|
| `active` | In the active set; rendered + locally searchable |
| `pending-send` | Waiting on companion ack of an outbound POST |
| `spooled` | Stored in chrome.storage spool; awaiting drain |
| `exported` | Written to a chrome.downloads archive pack |
| `companion-imported` | Companion has imported the export and acked the edge dot |
| `evicted-after-ack` | Removed from active set after companion ack |
| `failed-explicit` | Explicit user action rejected (no capacity) |
| `dropped-passive-by-policy` | Passive observation dropped (no capacity) |

The terminal states are deliberately distinct so the side panel can
render `failed-explicit` differently from `dropped-passive-by-policy`.
Explicit rejections need user action; passive drops just reduce
fidelity.

## Admit policy

The `PluginBudgetGuard` in
`packages/sidetrack-extension/src/sync/pluginMaterializer.ts`
implements the admit policy:

```ts
decideAdmit({
  intent: 'explicit' | 'passive',
  activeSetCount,
  spoolCount,
  activeSetBudget,
}) → AdmitResult
```

```text
if active < budget                    → admit to active
else if intent='explicit' and spool < maxExplicitPending
                                      → admit to spool
else if intent='explicit'             → REJECT (failed-explicit)
else if intent='passive' and spool < maxPassivePending
                                      → admit to spool
else                                  → DROP (dropped-passive-by-policy)
```

**Two intents, two policies:**

- **Explicit** actions (capture button, dispatch send, queue follow-up,
  annotation save) are user-authored. They must NEVER be silently
  dropped. If capacity is exhausted, return a visible rejection that
  the UI surfaces with recovery instructions.
- **Passive** observations (auto-track, timeline, …) come from
  background browser activity. They MAY be sampled, summarized, or
  dropped by policy. The drop is recorded in `droppedPassiveCount`
  so the operator can see degradation.

## Edge replica identity (single-identity model)

The plugin has a stable `edgeReplicaId`, generated once on first run
and persisted in `chrome.storage.local`. Every plugin-originated event
carries:

```ts
AcceptedEvent.dot = { replicaId: edgeReplicaId, seq: edgeSeq }
```

Companions import edge events via `importPeerEvent` and **do NOT
restamp them**. The edge dot is the canonical event identity. This
makes archive imports naturally idempotent:

| Scenario | Behavior |
|---|---|
| Same archive imported twice into one companion | Idempotent — same edge dots dedupe at the event log layer (gate L3-G7) |
| Same archive imported by two different companions | Both accept; relay-level dedupe handles cross-companion case (each side publishes; receiving peer dedupes on dot) |
| Partial import + retry | Companion checkpoints which edge dots it accepted; replay is idempotent |

The single-identity model is preferred over the dual-identity
fallback (where the archive carries a `boundCompanionId` and other
companions reject). If the dual-identity complexity is ever needed,
it is the documented fallback; the current design picks edge-replica.

`edgeReplicaId` lives at
`packages/sidetrack-extension/src/sync/edgeReplicaId.ts`. The
allocator (`allocateNextSeq`) persists `nextSeq` BEFORE the caller
emits the event — a kill mid-flight cannot re-use a dot.

## PluginMaterializer interface

```ts
interface PluginMaterializer<TItem> {
  readonly name: string;

  // Local mutation. Side panel calls this on user action. Always
  // optimistic — admits to active set immediately, queues for
  // companion. Returns within < 50 ms.
  readonly admitLocal: (item: TItem, intent: AdmitIntent) => Promise<AdmitResult>;

  // Companion → plugin sync (SSE-driven mirror).
  readonly mirrorFromCompanion: (item: TItem) => Promise<void>;

  // Extended-query fallback. Hits companion HTTP if reachable.
  readonly fetchExtended: (query: ExtendedQuery) => Promise<ExtendedResult<TItem>>;

  // Background drains.
  readonly drainSpoolToCompanion: () => Promise<{ uploaded: number; remaining: number }>;
  readonly exportSpoolToArchive: () => Promise<{ exported: number; archivePath: string }>;

  readonly health: () => PluginMaterializerHealth;
}
```

`PluginMaterializerHealth`:

```ts
{
  status: 'healthy' | 'degraded' | 'failed';
  activeSetSize: number;
  activeSetBudget: number;
  spoolSize: number;
  spoolBudget: number;
  companionReachable: boolean;
  lastReconcileAt: string | null;
  lastError: string | null;
  failedExplicitCount: number;
  droppedPassiveCount: number;
}
```

The existing `mirrorRemoteX` functions for threads, workstreams,
queue, and dispatches are wrapped as `PluginMaterializer` instances at
`packages/sidetrack-extension/src/sync/mirrorMaterializers.ts` and
exported via the `PLUGIN_MATERIALIZERS` registry. Iterating the
registry is how the side panel computes overall plugin-tier health.

## Result scope — extended-query honesty

```ts
type ResultScope =
  | 'plugin-active'
  | 'companion-extended'
  | 'plugin-active-only-companion-unreachable'
  | 'archive-exported-not-imported';

interface ScopedResult<T> {
  scope: ResultScope;
  items: T[];
  note?: string;
}
```

Every query that **could** cross the active-window boundary must
return a `ScopedResult`. The side panel renders the `note` honestly:

- `plugin-active` — fast path; no note.
- `companion-extended` — fast path; no note.
- `plugin-active-only-companion-unreachable` — note:
  "Showing recent local history only — companion unavailable."
- `archive-exported-not-imported` — note:
  "Older history is in exported archive packs that the companion has
  not imported yet."

No silent truncation. The user must always be able to tell the
difference between "we have nothing" and "we are not allowed to look."

## Storage layout

```text
chrome.storage.local:
  sidetrack.sync.edgeReplicaId      — { edgeReplicaId, nextSeq }
  sidetrack.sync.spool.<surface>    — SpoolEntry[] for one surface
  sidetrack.threads                 — active-set mirror of thread projections
  sidetrack.workstreams             — active-set mirror of workstream projections
  sidetrack.queue                   — active-set mirror of queue projections
  sidetrack.dispatches              — active-set mirror of dispatch projections
  sidetrack.annotations             — active-set annotation overlay
  ...                               — future surfaces register their own keys
```

The `sidetrack.sync.spool.<surface>` key is one array per surface so
spool drains and metrics scope cleanly.

## Mode behavior

**Mode P (companion offline):**

- `admitLocal` admits to active or spool per the budget guard.
- Explicit overflow → `failed-explicit`; UI shows a visible
  rejection.
- Passive overflow → `dropped-passive-by-policy`; counter increments
  in health.
- `mirrorFromCompanion` no-ops (no SSE).
- `fetchExtended` returns `plugin-active-only-companion-unreachable`.

**Mode P → Mode P+C transition (companion comes online):**

- `drainSpoolToCompanion` runs in the background. Each entry is
  POSTed; on companion ack the entry transitions
  `pending-send` → `evicted-after-ack`.
- Drain is idempotent: a partial-drain crash, on retry, re-POSTs the
  same edge dots — companion's `importPeerEvent` dedupes (gate L3-G5).

**Mode P+C+R (full sync):**

- Same as P+C plus the companion publishes accepted events to the
  relay; peer companions import them. Plugin sees the projections
  reflect cross-replica state via SSE mirror.

## Subtleties

- **The plugin spool is not the archive.** The spool lives in
  `chrome.storage` and is bounded. The archive is a chrome.downloads
  file the user (or an automation) hands off to a companion via
  `sidetrack-companion ingest --import <path>`. Archive export is a
  handoff, not guaranteed sync.
- **Eviction never loses data client-side until proven uploaded.**
  Active-set eviction goes through `pending-send` → spool, not direct
  to deletion. Only `evicted-after-ack` is safe to drop client-side.
- **Bootstrap is one-shot.** `loadOrCreateEdgeReplica` generates the
  edge id on first call and persists it. Subsequent extension
  upgrades read the same id from `chrome.storage.local`. If the user
  uninstalls the extension, the id is lost — that profile becomes a
  new edge replica on reinstall.

## Pointers

- `packages/sidetrack-extension/src/sync/budgetConfig.ts` — budgets.
- `packages/sidetrack-extension/src/sync/edgeReplicaId.ts` — identity.
- `packages/sidetrack-extension/src/sync/spool.ts` — state machine +
  storage.
- `packages/sidetrack-extension/src/sync/spoolDrainer.ts` — drain to
  companion.
- `packages/sidetrack-extension/src/sync/pluginMaterializer.ts` —
  interface + budget guard.
- `packages/sidetrack-extension/src/sync/mirrorMaterializers.ts` —
  threads / workstreams / queue / dispatches as PluginMaterializer
  instances + `PLUGIN_MATERIALIZERS` registry.
- `packages/sidetrack-extension/src/sync/resultScope.ts` —
  `ResultScope` + `buildScopedResult`.
- `packages/sidetrack-extension/src/sync/extendedQuery.ts` — query
  fallback against companion HTTP.
- `packages/sidetrack-extension/src/sync/captureQueueClassF.ts` —
  capture queue exposed as a Class F surface.
- `packages/sidetrack-extension/src/sync/extractionWindow.ts` —
  active extraction window for plugin-side recall.
