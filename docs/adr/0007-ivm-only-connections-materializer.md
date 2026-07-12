# ADR-0007 — IVM-only connections materializer (opt-out removed)

- Status: Accepted (retroactive, 2026-07-11)
- Date: 2026-07-11
- Owner: User + Claude
- Components: API | Shared
- Related: ADR-0006, PRD §5

## Context

The connections materializer computes the Sidetrack workstream graph
(nodes, edges, topic affiliations, similarity edges) by replaying
causal events. Two execution strategies existed during development:

- **Full rebuild**: on every drain, load all events, replay from
  scratch, write the new snapshot. Simple but O(N) in the event log.
- **IVM (incremental view maintenance)**: on each drain, read only the
  delta of events since the last snapshot, apply incremental mutations
  to the persisted `SqliteConnectionsStore`. O(delta) per drain after
  the initial build.

The IVM path was initially behind an environment flag
(`SIDETRACK_IVM_CONNECTIONS`) to allow opt-out during validation.
After the Class B IVM design landed and proved stable in dogfood, the
opt-out was removed.

The companion's `connections/snapshot.ts` comment at line 3763 records
this: "IVM is the only supported path — env-opt-out removed."

## Decision

IVM is the sole supported execution path for the connections
materializer. The full-rebuild path is removed. The environment-flag
opt-out is removed.

The connections materializer:
1. On first run (or after a rebuild/reset), performs a full initial
   build from the event log.
2. On subsequent drains, reads only the event delta since the last
   persisted watermark and applies incremental mutations.
3. Persists the connections graph in `SqliteConnectionsStore` (ADR-0006).

## Options considered

### Option A — Keep full-rebuild as a fallback path

Pros:
- Safety net if IVM produces divergent results.

Cons:
- Full rebuild is O(N) in the event log. At 450k+ events, it takes
  seconds per drain. This was the root cause of the P0-A CPU runaway
  (see memory `project_live_browsing_downtime_eval.md`).
- Two code paths to maintain; the full-rebuild path is the slower one
  and atrophies when not exercised.
- The opt-out flag adds complexity with no validated use case.

### Option B — IVM only (chosen)

Pros:
- Drain cost is O(delta) after initial build.
- Single code path; simpler invariants.
- Validated in dogfood: zero full rebuilds after the Class B IVM
  design, 5/5 scoped drains confirmed live.

Cons:
- If IVM produces a divergent graph, the recovery path is an explicit
  rebuild (companion restart with rebuild flag), not an automatic
  fallback. This is acceptable: divergence is detectable via the
  health surface and auditable via event log replay.

## Consequences

Positive:
- Per-drain cost is bounded by the delta size, not the event log size.
- CPU usage during active browsing is eliminated as a materializer
  concern (validated: ~144% CPU → ~3% after IVM + related fixes).
- No environment variable to document or explain.

Negative:
- An initial build is required after wipe or first install. Duration
  is proportional to event log size (empirically ~2-5 s for the
  current dataset).
- IVM correctness is the only path; regression tests must cover the
  IVM delta accumulation invariants.

## Extension model

New event types that affect the connections graph must add an IVM
handler to `snapshot.ts` alongside the existing type handlers. There
is no full-rebuild path to update as a fallback.

## Security and operations impact

No change to permissions or remote services. The IVM store lives in
`_BAC/data/connections.db` (ADR-0006) and is owned by the companion.
