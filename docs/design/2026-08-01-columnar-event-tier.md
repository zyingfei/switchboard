# Columnar event tier: hot JSONL tail + sealed Parquet segments

2026-08-01 · status: design accepted pending review; PoC gate PASSED · task #199

Owner directive: "introduce chdb, duckdb, parquet etc necessary, no raw files
parsing, this won't scale." This design makes raw-file parsing a bounded,
shrinking hot path rather than the steady state, without touching the
canonical-log contract.

## PoC gate results (real vault shard, Bun 1.3.14, macOS arm64)

`@duckdb/node-api` (official NAPI client), scripts in the session scratchpad:

- 25× open/close in one process: clean (no better-sqlite3-class crash).
- `read_ndjson` over a real 14.2MB day shard (62k lines, heterogeneous
  payloads, `ignore_errors`): works, correct type counts.
- Parquet seal (zstd): **14.2MB → 0.6MB (22.9×)**. Extrapolated: the entire
  ~621MB event log seals to roughly ~27MB.
- Filtered count benchmark, identical result three ways: Bun `JSON.parse`
  loop 34ms; DuckDB over raw JSONL **98ms (slower — engine+inference
  overhead at shard scale)**; DuckDB over sealed Parquet **2ms**.
- Event-loop check: 28ms max gap on a 25ms ticker during a heavy query —
  queries run off the JS thread.

Conclusions the design must honor: sealing is the win, engine-over-raw-JSONL
is not; the engine never blocks serving; chDB is unnecessary (DuckDB
suffices); Parquet+JSON readers are built in (no extension download).

## Invariants (unchanged)

1. `_BAC/log/<replica>/<day>.jsonl` stays canonical, append-only, replayable,
   human-recoverable; external shard writers and signature-guarded appends
   unchanged; retraction events resolved at fold time on semantic timestamps.
2. Multi-replica semantics (dots, intervals, gap sealing) unaffected: sealing
   is a LOCAL read-optimization, invisible to sync.
3. Local-first: DuckDB in-process; nothing outbound.
4. bun:sqlite OLTP serving (resolver generations, sqlite-vec) untouched —
   this tier serves SCANS, not point reads.
5. Every stage behind an env kill switch, default OFF, additive-only until
   proven; the JSONL is never deleted by this system (deletion remains the
   engagement-compaction system's, which stays independently double-gated).

## Architecture

### Sealer (background, flag `SIDETRACK_EVENT_SEAL`)

A day shard is SEALABLE when it is closed (not today's file for that replica)
and fully ingested by the event store (its dots ≤ the store watermark — the
same handshake catch-up already uses). The sealer:

1. reads the shard through the EXISTING typed store (not a second JSONL
   parser), writes `_BAC/seal/<replica>/<day>.parquet` (zstd) with columns
   `(replica_id, seq, type, accepted_at_ms, aggregate_id, client_event_id,
   payload JSON)` — payload stays a JSON column: schema evolution across
   payloadVersion bumps is then a non-event, and DuckDB predicates on the
   exploded hot columns cover every measured scan;
2. verifies by count + per-replica (min,max seq) interval equality against
   the store for that shard — mismatch aborts the seal (never a partial file:
   temp + atomic rename + dir fsync);
3. appends to `_BAC/seal/manifest.jsonl` (append-only, same crash discipline):
   `{replica, day, rows, seqLo, seqHi, sha256, sealedAt}`.

Rollback: delete the seal dir + manifest; nothing else changed. The manifest,
not directory listing, is the source of truth for what is sealed.

### Query facade: `src/analytics/eventScan.ts`

One module owning the only DuckDB connection. A scan plans as:
`(manifest-covered sealed segments via DuckDB)` ∪ `(everything newer via the
existing typed store reads)` — one API, callers never know the split. The
facade exposes exactly the shapes today's scan consumers use: typed event
streams, and (better) SQL aggregations that return rolled-up results so rows
never materialize in JS (the direction eventStore.ts's own header comment
already points).

Consumer migration order (highest byte-reparse savings first, each its own
flag-guarded PR): (1) engagement compaction planner + vault-ledger analytics
(read-only, easiest rollback); (2) golden eval + prequential filings scan;
(3) event-store catch-up itself: `catchUpFromJsonl` skips manifest-covered
byte ranges entirely — cold boot ingests only the unsealed tail, which
directly shrinks the one remaining awaited catch-up (boot); (4) the
readMerged full-log fallbacks (gap-seal path).

### What this deliberately does NOT do

- Not a second copy of the truth for sync: seals mirror the log, and the
  event-store mirror can eventually SHRINK to hot-tail-only (its 768MB is
  the second-largest family) — that retirement is step (3)'s payoff, taken
  only after seals are verify-green for a soak period.
- Not the embed-cache fix (#197): vectors want an appendable segment format;
  evaluate Parquet fixed-size lists vs sqlite-vec there separately.
- Not compaction (#193): but sealing makes it cheap later — dropping
  compacted engagement events becomes writing a filtered seal + updating the
  manifest, instead of rewriting JSONL.

## Risks and mitigations

- Bun/NAPI regression on Bun upgrades: the facade isolates DuckDB behind one
  module with a pure-JS fallback (hot-path typed reads still work without the
  engine — sealed segments are additive).
- Engine memory: one lazy connection, closed when idle; PoC showed no
  resident growth at shard scale; measure at full-seal scale behind the flag.
- `ignore_errors` masking malformed rows: the count/interval verification in
  the sealer is the guard — a seal that drops a row does not publish.
- Manifest/log divergence (external writers appending to a sealed day): the
  seal covers (seqLo..seqHi) intervals, not "the day"; catch-up still reads
  bytes past the sealed intervals, so late appends are never lost — they are
  simply unsealed until the next sealer pass.

## Rollout

1. Land sealer + manifest, flag OFF; enable on the TEST clone; verify-only
   soak (counts green, zero serving change).
2. Facade + consumer (1); A/B the planner outputs sealed-vs-store for a week.
3. Consumers (2)-(4); then propose event-store hot-tail-only retirement with
   measured numbers.
