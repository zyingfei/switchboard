# Engagement compaction safety contract

Status: implemented 2026-07-31. This contract applies only to sealed
`_BAC/log/<replica>/<YYYY-MM-DD>.jsonl` shards and only to validated
`engagement.interval.observed` events whose visit has a validated
`engagement.session.aggregated` event.

## Boundary contract

`planEngagementCompaction` is the read-only boundary. It parses JSONL as
`unknown`, applies the canonical accepted-event and engagement-payload guards,
and reports proof status, exact candidate dots, counts, and bytes. A plan is
eligible only when the environment arm is set, at least one covered interval
exists, and aggregate coverage, exact-sequence reconciliation, crash recovery,
downstream-consumer, writer-lifecycle, and lane-health proofs all pass.

`applyEngagementCompaction` has no force path. Online callers must supply the
active `EventLog`, which runs the rewrite behind its append mutex and invalidates
the add-only append indexes afterward. Offline callers must explicitly assert
the companion is stopped. The durable receipt is
`_BAC/connections/engagement-compaction-manifest.json` (schema version 1); its
paths are `_BAC/log`-relative and traversal-rejected.

`engagement.session.aggregated` is the primary serving input. Raw intervals are
retained when aggregate coverage is absent and remain available to the repair
backfill; compaction never synthesizes an outcome or changes engagement gates.

## Failure and recovery

For every shard, apply computes source and compacted SHA-256 digests and exact
removed sequence ranges. It durably writes all prepared receipts before any
atomic shard rename. After a crash, each receipt-covered shard must match either
the source or compacted digest; a retry completes source-state entries. A shard
or receipt that matches neither state blocks planning and applying.

The event store recognizes an intentional shrink only when the compacted digest
matches, the prior progress corresponds to the source size, and every retained
event is already present with the same dot and client event id. It removes only
receipt-listed raw interval rows. Fresh rebuilds ingest retained rows before
advancing across compacted dots.

Reconciliation computes `expectedRetainedCount = sum(watermark) - trusted exact
compacted dots`. It never treats an inferred dense range as compacted. A missing
unrelated sequence therefore remains a non-zero data-loss delta. If the receipt
becomes absent, invalid, or mismatched, compacted-dot credit is withdrawn until
the matching receipt is restored.

## Observability and privacy

Plan and apply emit stable operations
`sidetrack.gc.engagement_compaction.plan` and
`sidetrack.gc.engagement_compaction.apply`. Observations include outcome,
duration, candidate shard/event/byte counts, every proof status, skip reason,
and a bounded error category. They never include vault paths, visit ids, URLs,
or payloads.

Lane health distinguishes retained interval evidence from compacted-only or
absent evidence. The latter states are reported as `unknown`, not as false
`not-flowing` evidence.

## Extension model

Future compactable event families add their own canonical coverage predicate
and consumer proof. They may reuse the receipt and exclusive-maintenance
protocol, but must use a distinct manifest schema/type and must not add dots to
reconciliation credit until their own read-back acceptance test proves the
same served artifact before and after the real compaction path.
