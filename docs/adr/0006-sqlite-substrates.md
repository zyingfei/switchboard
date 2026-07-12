# ADR-0006 — SQLite substrates: event-store mirror, connections store, recall store

- Status: Accepted (retroactive, 2026-07-11)
- Date: 2026-07-11
- Owner: User + Claude
- Components: API | Shared
- Related: ADR-0004, ADR-0009, PRD §5 (vault canonical state)

## Context

The Sidetrack companion uses three distinct SQLite databases for
different purposes. Each arose independently as the product evolved;
this ADR records the decision to canonize three separate substrates
rather than one shared database.

1. **Event-store mirror** — a derived, persistent SQLite mirror of the
   causal JSONL event log. The JSONL files under `_BAC/events/` remain
   the source of truth; the SQLite store is rebuildable at any time by
   replaying the JSONL shards. Its purpose is to let hot materializers
   read small ordered tails without loading the full `AcceptedEvent[]`
   heap. Implemented in
   `packages/sidetrack-companion/src/sync/eventStore.ts`. Keyed on
   `(replicaId, seq)`; per-replica watermarks prevent double-ingestion.

2. **`SqliteConnectionsStore`** — the default and now only backing store
   for the connections graph materializer. Holds nodes, edges, and a
   full edges index (`edges_index`) for O(1) edge lookups. Implemented
   in `packages/sidetrack-companion/src/connections/snapshot.ts`.
   Replaced the prior JSON-file snapshot, which serialized the full
   graph to disk on every drain and could not serve edge lookups
   without deserializing the whole structure.

3. **sqlite-vec recall store** — the vector and FTS index for the `/v2`
   recall pipeline. Uses the sqlite-vec extension (loaded via
   `setCustomSQLite` to a system libsqlite3 with extension support;
   see ADR-0009). Implemented in
   `packages/sidetrack-companion/src/recall-v2/store/`. Stores page
   embeddings, timeline-visit embeddings, and FTS5 text rows for
   lexical recall. Index is a rebuildable cache (rebuild from vault
   events; never canonical state per PRD §5).

## Decision

Maintain three separate SQLite databases, each scoped to its
subsystem. Do not merge them into a single shared database.

- Event-store mirror: `<vault>/_BAC/data/event-store.db` (path
  managed by `eventStore.ts`).
- Connections store: `<vault>/_BAC/data/connections.db` (path managed
  by `snapshot.ts`).
- Recall store: `<vault>/_BAC/recall/store.db` (path managed by
  `store/sqlite.ts` in the recall-v2 package).

## Options considered

### Option A — Single shared database for all three substrates

Pros:
- One DB file to manage; transactions span subsystems.

Cons:
- Subsystems drain at different cadences and have different write
  patterns; sharing a WAL creates contention.
- The recall store needs sqlite-vec loaded; imposing that requirement
  on event-store and connections readers adds coupling.
- Rebuilding the recall index (a common operation) would lock the
  event-store and connections during the rebuild.

### Option B — Three separate databases (chosen)

Pros:
- Each substrate is independently rebuildable without affecting others.
- The sqlite-vec requirement is isolated to the recall store.
- Write contention is contained per subsystem.
- Simplifies the rebuild/reset path per subsystem.

Cons:
- Three DB file paths to document and manage.
- No cross-subsystem transactions (not needed for current use cases).

## Consequences

Positive:
- Recall store can be wiped and rebuilt without touching event history
  or the connections graph.
- Connections and event-store operations do not require sqlite-vec.
- Each store has a single owning module; callers do not share handles.

Negative:
- Three database files must be included in any backup/export of
  `_BAC/` (they are rebuildable but expensive to rebuild cold).
- Developers need to understand which store serves a given query.

## Extension model

If a fourth SQLite-backed subsystem is added, it follows the same
pattern: isolated DB file, owning module, rebuildable from canonical
JSONL or vault state, no cross-substrate transactions. Load sqlite-vec
only if the substrate needs vector operations (requires ADR-0009
import-order invariant).

## Security and operations impact

All three databases live inside `<vault>/_BAC/` and are governed by
the companion's filesystem access. They are never written by the
extension or MCP server. The JSONL event log remains the source of
truth for disaster recovery — the SQLite stores can always be
discarded and rebuilt from JSONL.
