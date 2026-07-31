# Storage duplicate retirement

## Purpose

Sidetrack keeps the vault canonical while reclaiming four historically useful
duplicates: the legacy connections rollback anchor, fully mirrored legacy
capture-spool days, the disabled SQLite event-store mirror, and abandoned graph
generations. Projection-change history is bounded by proof-gated rotation. The
canonical `_BAC/log` JSONL bytes are never candidates.

## Boundary contract

`sidetrack-companion gc --vault <path> --storage-retirement --dry-run` produces
a versioned plan with a stable `planId`. Every candidate has an artifact kind,
an explicit path set, measured bytes, a stat/content fingerprint, a typed
`absent | refuted | verified` proof, and its recovery source. Apply requires a
second invocation with `--storage-retirement --apply --plan-id <reviewed-id>`.
It rebuilds the complete plan before the first unlink and rejects any changed
path, fingerprint, proof, candidate set, or plan ID.

The event-store lineage entry encodes `_BAC/log` as its authoritative source
and `disabled-and-canonical-readback-verified` as its retirement criterion.
SQLite is a rebuildable mirror; it is never promoted back into JSONL.

## Proofs and recovery

- `current.db`: double buffering must be active; `current.gen` must remain
  stable around a readonly `PRAGMA quick_check`; the pointed generation must
  carry S1's SHA-256 content signature; and any progress checkpoint must parse
  and name that generation. WAL/SHM sidecars refute retirement because they may
  indicate a live legacy handle. A later kill-switch boot recreates
  `current.db` from the immutable pointer generation.
- Ingress spool: every non-empty line must parse and have a matching `bac_id`
  plus byte-equivalent capture payload in a structurally valid, durably read
  `capture.recorded` JSONL event. One missing, malformed, or mismatched record
  keeps the entire day.
- Event-store mirror: `SIDETRACK_EVENT_STORE` must be disabled; SQLite must pass
  `quick_check`; canonical shards must parse completely; and every mirror row
  must be byte-equivalent to the event at the same causal dot in JSONL. The
  mirror may be stale (JSONL may have newer rows) because rebuild consumes the
  authoritative superset. A mirror containing compacted-dot receipt rows is
  currently refuted: those rows derive from a separate signed manifest, and S2
  does not collapse that second recovery input into a false “JSONL-only” proof.
- Graph generations: the `current.db` S1 proof above is also the arming proof.
  The pointer generation, live-marker generations, young generations, and a
  retired-handle grace window remain protected. The background survey is
  report-only; an environment flag without S1 proof cannot collect.
- Projection changelog: before rotation, every source line must parse, the
  source byte count must match stat, and its high-water must not exceed the
  durable sequence. A loss floor is durably written before replacing `.1`, the
  renamed bytes are hashed/read back, and an atomic rotation-proof record is
  persisted. Malformed or incomplete logs stay over cap rather than rotate.

## Security impact

All targets are absolute paths confined beneath the selected vault's `_BAC`
namespace. Apply rejects traversal, relative paths, the `_BAC` root, and every
path under `_BAC/log`. Plans contain paths, revision identifiers, hashes, and
counts but no tokens or credentials. This is a local CLI operation and adds no
HTTP permission or authorization surface.

## Failure behavior

Missing proof never means empty state. Planning reports it as `absent` or
`refuted`, and apply ignores it. A stale plan fails before mutation. After full
validation, an individual unlink error is reported with its candidate and
path; already-missing paths are idempotent. Generation removal is re-surveyed
under the cross-process publish lock and refuses a pointer or newly protected
generation. Canonical recovery bytes are not modified during any failure path.

## Observability

The dry-run and JSON output expose `planId`, `verifiedCount`,
`reclaimableBytes`, per-candidate proof status/evidence, and exact paths. Apply
reports `removedCandidates`, `removedPaths`, reclaimed bytes, and errors.
Projection feeds expose rotation attempts, completions, refusals, and the last
read-back hash; the durable proof records source hash, bytes, max sequence, and
the retired floor. The vault ledger continues to report the generation survey,
including requested versus effectively armed sweep state.

## Extension model

New duplicate families add a typed artifact kind plus a report-time proof and
an apply-time revalidation path in `storageRetirement.ts`. They do not join the
ordinary derived-revision GC until their proof and recovery source are equally
explicit. A future event-store engine declares the same authority/retirement
contract in `sync/lineage.ts`; canonical-source changes require a separate ADR.

## Verification evidence

- `bun test` across storage retirement, ingress retention, projection changes,
  event store, lineage, generation buffer, S1 double-buffer acceptance, vault
  ledger, and CLI: 100 passed, 0 failed, 486 assertions.
- `bunx --bun --no-install tsc --noEmit -p tsconfig.build.json`: passed.
- Focused ESLint: 0 errors; six pre-existing/concurrent warnings in CLI tests,
  generation-buffer tests, and runtime composition.
- Focused Prettier check and `git diff --check`: passed.
