# R4 canonical vector corpus and projection lifecycle

**Status:** implemented behind the frozen legacy input policy  
**Scope:** companion materialized visit similarity and recall-v2 chunk retrieval  
**Serving change:** none

## Boundary and invariant

`recall/vectorCorpus.ts` is the canonical boundary for text-addressed vectors.
The durable corpus remains `_BAC/recall/embed-cache.bin`; HNSW and sqlite-vec
are rebuildable retrieval projections. A vector is identified by the pinned
model, model revision, active input-policy revision, dimension, and sha256 of
the exact caller-supplied embedding text. Materialized visit similarity and
recall-v2 chunk backfill both resolve through this boundary before updating
their own projection.

The two consumers keep their existing populations and corpus text. Visit
similarity still embeds engaged visit title/host/path (or the existing gated
content variant) and recall still embeds page-content chunks. Edge thresholds,
ranking, lane fusion, eligibility, and user-visible empty behavior do not
change.

## E5 query/passage decision

The served profile is explicitly named `legacy-query-wrapper-v1`. It preserves
the inputs that produced the current vectors:

| caller text      | served model input     |
| ---------------- | ---------------------- |
| `passage: body`  | `query: passage: body` |
| `query: focus`   | `query: query: focus`  |
| unprefixed query | `query: …`             |

`e5-asymmetric-v1` is implemented as a non-serving shadow policy. It produces
the model-recommended single `passage:` or `query:` prefix, but promotion would
change every stored vector and cosine. It requires a complete shadow rebuild,
golden/eval evidence, floor-guard acceptance, and an ADR-0011 serving
authorization.

The parent now applies the active policy before invoking any embedder override.
The embedder child consumes those prepared model inputs without applying a
second wrapper. In-process, sidecar, and injected execution therefore cannot
silently place different vectors under the same corpus key.

## Lifecycle, migration, and rollback

The prior cache header used the bare model revision. On the first off-thread
corpus resolve, migration takes a bounded cross-process writer lock, copies the
old file to `embed-cache.bin.rollback`, and atomically republishes the same
vectors under the input-policy-aware corpus revision. No inference and no
vector-value change occurs during migration. `rollbackMigration()` restores
the byte-for-byte legacy file; a failure before publication leaves the legacy
file active.

Writer exclusion is bounded to six attempts with exponential 5 ms backoff.
Contention raises typed `EMBEDDING_CACHE_BACKPRESSURE`; callers retry through
their existing worker/materializer lifecycle rather than blocking a serving
request. A lock older than two minutes is treated as an orphan left by a dead
process and recovered before retry. Query-time recall remains read-through only
and never performs corpus migration or a cache write.

HNSW sidecars are schema v2 and record model id, model revision, dimension, and
canonical corpus revision. Schema-v1 sidecars are accepted once under the
frozen compatibility policy and become self-describing on the next atomic
persist. Recall publishes its corpus revision and typed projection state only
after vector transactions finish. A crash before that point reads back as
absent/stale and is retried.

## Absent versus empty and point-in-time provenance

Corpus read-back is a tagged union:

- `absent`: no current corpus publication exists;
- `empty`: the current revision was initialized and contains zero vectors;
- `measured`: the current revision contains an explicit vector count.

Recall projection read-back uses the same absent/empty/measured distinction.
Projection bindings record consumer, sha256 projection id, text hash, source
revision, and effective timestamp. Raw URLs, captured text, prompt-injection
strings, and secrets are never written to the binding sidecar. Upstream
captured-page injection scrub and redaction remain mandatory before text
reaches this derived boundary.

After each successful HNSW reconcile or recall chunk sweep, bindings for
deleted projection ids are pruned against the consumer's live id set. The
content-addressed vector may remain as a reusable cache value, but no stale
consumer provenance can be mistaken for live read-back coverage.

## Failure behavior and observability

Corpus resolution validates result count and the manifest dimension before
publishing. Migration, writer contention, malformed bindings, and dimension
mismatch fail closed; projection publication cannot claim a revision before
its writes commit. HNSW retains atomic index/sidecar/pointer publication, and
recall retains per-batch sqlite transactions and restartable backfill.

Structured lifecycle logs contain `consumer`, `revision`, `hits`, `embedded`,
and `migrated`. In-process counters expose cache hits/misses, embedded count,
migration success/failure, and binding backpressure. HNSW `vectorIdentity()`
and recall metadata provide deterministic operator read-back.

## Extension model and acceptance evidence

Future embedding policies add a `VectorInputPolicyId`; they do not modify
consumer ranking code. Future ANN implementations bind to the canonical corpus
revision and remain disposable projections.

Deterministic tests cover legacy and corrected prefix goldens, in-process versus
override input equivalence, shared-vector cache hits across both consumers,
point-in-time bindings, raw-text non-persistence, absent versus empty,
migration, rollback, backpressure recovery, HNSW identity read-back, recall
projection accounting, and unchanged visit-similarity/cache behavior.
