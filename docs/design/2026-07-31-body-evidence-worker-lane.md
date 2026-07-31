# Body-evidence worker lane

**Status:** Implemented (R3)  
**Date:** 2026-07-31  
**Target:** Raise page-body and content-vector evidence coverage from the
observed 13.6% floor toward at least 80%, without running chunking, corpus
scans, manifest rebuilds, or model inference on the HTTP serving thread.

## Context and decision

Auto/attention capture intentionally sends
`POST /v1/page-evidence/extracted` with `storageMode: features_only`. Before
R3, the companion extracted semantic features and then discarded the body.
The existing background embedding lane could revisit the record, but it had no
page-content payload from which to reconstruct a document vector.

R3 keeps two responsibilities explicit:

```text
features_only HTTP capture
  -> bounded durable scrubbed-body queue (one atomic admission write)
  -> worker_thread body/chunk materialization + served-store read-back
  -> existing child-process embedding lane (the only vector producer)
  -> cached body/vector coverage health
```

The feeder does not embed. The embedding lane does not own raw-body capture.
Both lanes are default-on only when companion child processes are enabled;
`SIDETRACK_BODY_EVIDENCE_WORKER=0|false|off` and
`SIDETRACK_PAGE_EVIDENCE_BACKGROUND_EMBEDDING=0|false|off` are independent
kill switches. No serving-math or recall-preference flag is changed.

## HTTP boundary contract

The existing authenticated, idempotent
`POST /v1/page-evidence/extracted` operation retains its request contract. Its
202 response gains an additive `data.bodyEvidenceQueue` property for
`storageMode: features_only`:

```json
{
  "data": {
    "evidence": {},
    "bodyEvidenceQueue": {
      "state": "queued",
      "jobId": "sha256-hex",
      "pendingCount": 1,
      "cap": 2048
    }
  }
}
```

`state` is `queued`, `coalesced`, or `backpressure`. `coalesced` means a newer
capture replaced the pending revision for the same canonical URL.
`backpressure` is explicit: the fast feature record is still accepted, but
the body was not admitted and a later capture must retry with a new
idempotency key. `indexed_chunks` requests retain the existing synchronous
materialization behavior and omit `bodyEvidenceQueue`.

Admission performs no body chunking, manifest/corpus scan, or embedding. It
does one bounded, atomic local-vault write before returning so acknowledged
work survives process restarts. Failure to acquire/write that durable boundary
fails the request rather than claiming the body was queued.

`GET /v1/status` may include a cached `bodyEvidenceLane` object. The status
handler never scans queue or page-evidence storage. The object reports queue
source/cap/backpressure, invalid/dead-letter counts, process success/retry/
safety-discard counters, last-cycle state, and coverage.

## Storage and safety contract

Queue records live only under the reserved namespace:

```text
_BAC/page-evidence/body-evidence-queue/pending/<canonical-url-hash>.json
_BAC/page-evidence/body-evidence-queue/failed/<canonical-url-hash>.json
```

Before the durable boundary, the companion:

- canonicalizes the URL and drops the raw URL, Markdown copy, dimensions,
  workstream ID, and domain-policy ID;
- applies the companion redaction pipeline to body and title;
- wraps high-confidence prompt-injection content in
  `<context untrusted="true">` rather than treating page text as instructions;
- recomputes content hash and character count from the safe text; and
- records explicit untrusted-content, redaction, and injection-scrub metadata.

The transform is idempotent and preserves prior redaction provenance. The
worker reapplies it after parsing the queue/process boundary, so a malformed
or manually modified queue record cannot bypass minimization, redaction, or
injection handling. Logs and health contain counters/ratios only—never URL,
title, body, token, or content hash.

Privacy deletion and newer manual indexing win over background work. Worker
materialization, queue replacement, manual indexing, and tombstone publication
share a hashed per-canonical-URL filesystem lock. The worker re-reads queue
identity only after acquiring that lock, so each competing operation is ordered
wholly before or after its served-store write; a superseded job performs no
write. Tombstone and recanonicalization routes remove pending/dead-letter copies
inside the same critical section, while the lane still rechecks the domain
tombstone set before dispatch. The job ID also guards acknowledgement, so an old
completion cannot delete a newer queued revision. This avoids a late
"compensating" tombstone that could itself overwrite a newer manual index.

## Failure and lifecycle behavior

- Queue cap: 2,048 distinct pending canonical URLs, with latest-wins URL
  coalescing and an atomic admission lock.
- Feeder batch cap: four queue visits per cycle; backlog cadence five seconds,
  initialized-empty cadence sixty seconds.
- Retry: persisted exponential backoff from 30 seconds, capped at 15 minutes;
  three attempts, then a durable dead letter.
- Worker timeout: 60 seconds. Invalid worker messages, exit, or timeout become
  bounded `worker_unavailable` retries.
- Read-back acceptance: a job succeeds only when page-content coverage reads
  as indexed and the page-evidence record reads as `indexed_chunks`, both with
  the exact safe content hash. Manifest rebuild failure keeps the job queued.
- Notification acceptance: the runtime appends a safe
  `page.content.extracted` event before acknowledgement. Append failure retries
  the idempotent materialization.
- Restart recovery: pending jobs and retry timestamps are read from the vault;
  no in-memory ownership is required.
- Vector producer: the existing embedding lane visits at most eight candidates
  per four-second cycle, pauses for connection drains, quarantines repeated
  failures with cooldown recovery, and performs model inference only through
  the embedder child process.

## Coverage and observability

Coverage uses served read models rather than write-call success:

- body eligible = `content_features_only + indexed_chunks`;
- body materialized = `indexed_chunks`;
- vector eligible = body eligible;
- vector ready = content records with a document-vector reference.

Both ratios have target `0.8`. Signal state is explicit:

- `absent`: page-evidence storage does not exist; counts/ratios are `null`;
- `empty`: storage exists but has zero eligible records; ratios are `null`;
- `measured`: at least one eligible record; ratios and target booleans exist.

Each feeder cycle emits `page_evidence.body_lane.cycle` with
`queue_source`, `pending_before`, `attempted`, `succeeded`,
`retry_scheduled`, `dead_lettered`, `safety_discarded`, `invalid_items`,
`pending_after`, `body_coverage_ratio`, `vector_coverage_ratio`, and
`target_coverage`. `/v1/status` exposes the corresponding cached health plus
process-lifetime counters. This makes an absent signal, initialized-empty
signal, retry stall, backpressure condition, and true coverage regression
distinguishable without synchronous diagnostics on the request path.

## Extension model and verification

`createBodyEvidenceLane` depends on injected queue, worker, acknowledgement,
failure, tombstone, notification, clock, and logging ports. A future scheduler,
storage adapter, or materializer can replace one port without changing HTTP
routing or the queue state machine. `runBodyEvidenceWorker` validates both job
and result messages as `unknown` at the worker boundary.

Deterministic tests cover absent versus empty, queue admission/coalescing/
backpressure, stale completion, persisted retry and dead letter, restart
recovery, tombstone discard, content-safe logs, boundary validation,
redaction/injection re-scrubbing, served-store read-back, and the complete
feeder-to-vector path. The coverage fixture starts with five feature-only
records, materializes and embeds four, and reads back body coverage `0.8` and
vector coverage `0.8`.
