# Generation publish gating

## Purpose

Connections events can advance the materializer frontier without changing the
served graph. In double-buffer mode, those acknowledgements must not clone,
checkpoint, and pointer-publish the full SQLite generation. Sidetrack therefore
stores graph-inert progress in an atomic generation-bound checkpoint and gates
repeated full-snapshot writes with a SHA-256 signature of the served content.

## Boundary contract

`_BAC/connections/progress.checkpoint.json` is a companion-internal persistence
boundary. It contains a schema version, the exact generation ID, a timestamp,
and validated materializer progress. A checkpoint is eligible only when its
generation ID, snapshot revision, materializer name, and materializer version
match the open generation and its intervals monotonically cover the progress
embedded in SQLite.

The existing system health response adds three process-lifetime diagnostics to
`connectionsDoubleBuffer`: `unchangedPublishSkipCount`,
`progressCheckpointCount`, and `lastPublishSkipAtMs`. This is additive and does
not add a new HTTP operation or mutation surface.

## Security impact

The companion writes only inside the reserved `_BAC/connections` namespace.
The checkpoint contains causal dots and revision identifiers, not page content,
tokens, or credentials. The stored content signature is one-way metadata and is
not returned as part of the served graph. No permissions, authentication,
authorization, or user-consent behavior changes.

## Failure behavior

Checkpoint publication uses the vault atomic-write primitive (file sync,
rename, and directory sync). Missing, malformed, truncated, version-mismatched,
revision-mismatched, non-monotonic, or superseded checkpoints are never treated
as empty progress: readers fall back to progress embedded in the complete
SQLite generation, and the canonical JSONL log remains the replay source.

A materializer-version change bypasses the checkpoint and performs a normal
generation publish so the new version becomes the crash-recovery baseline. If
the generation pointer changes during a checkpoint write, the acknowledgement
fails rather than claiming durability against an ineligible checkpoint; replay
is safe and idempotent. Graph changes still use the existing shadow,
checkpoint-TRUNCATE, compare-and-swap pointer publication path, so readers see
one complete old or new generation and never a partially built database.

## Observability

`unchangedPublishSkipCount` counts graph publications avoided by either the
progress-only path or an identical full snapshot. `progressCheckpointCount`
counts successfully written generation-bound checkpoints, and
`lastPublishSkipAtMs` records the last avoided publish. All three have explicit
zero/null values when no skip has occurred.

## Extension model

Checkpoint parsing, interval merging, and generation eligibility live in
`progressCheckpoint.ts`; a future checkpoint schema can be added there without
changing graph materialization. Full-snapshot gating is isolated at the
`ConnectionsStore` persistence seam. Scoped and projection-overlay writes clear
the strong signature because they do not hold the complete graph, causing the
next full write to conservatively publish once and re-establish a trustworthy
signature.
