// Generic capture-event ingestion route (POST /v1/events).
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { CAPTURE_RECORDED } from '../../recall/events.js';
import { CaptureAdmission, captureAdmissionPassthroughFromEnv } from '../captureAdmission.js';
import { captureEventSchema } from '../schemas.js';

import { mutationResponse, readBody, requireIdempotencyKey, runIdempotent, writerForBucket } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

// ---- Capture-admission gate for POST /v1/events -----------------------
// The extension posts FULL-THREAD SNAPSHOTS on every capture; an active/idle
// ChatGPT tab produced 552 captures in one hour, mostly byte-identical content
// or streaming snapshots where each supersedes the previous. Each ACCEPTED
// capture triggers ~15-18s of downstream materializer work on the single Bun
// loop, so the serial write path collapsed (56-minute POST latencies).
//
// The admission gate (see captureAdmission.ts) drops that flood before any
// vault write / event-log mirror / materializer work runs, via two mechanisms:
//   1. content dedup — an identical re-capture of a thread returns the last
//      accepted {bac_id, revision} immediately (no work);
//   2. per-thread latest-wins single-flight — while a capture is in flight,
//      newer snapshots for the same thread coalesce into a single pending-next
//      (queue depth bounded at 1 by construction), so a burst collapses to the
//      newest snapshot.
// Kill switch: SIDETRACK_CAPTURE_ADMISSION=0 → passthrough (process every
// capture directly). Absent / any other value = ON. This instance is attached
// to the server module and persists across requests, mirroring resolveSwrCache.
const captureAdmission = new CaptureAdmission({
  maxThreadKeys: 500,
  passthrough: captureAdmissionPassthroughFromEnv(),
});

export const eventsRoutes: readonly RouteDefinition[] = [
  {
    method: 'POST',
    pattern: /^\/v1\/events$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'appendEvent', idempotencyKey, async () => {
        const input = captureEventSchema.parse(await readBody(request));
        // Capture-admission gate: the extension posts full-thread snapshots on
        // every capture, mostly identical or streaming-superseded, and each
        // ACCEPTED capture costs ~15-18s of materializer work on the single Bun
        // loop. The gate dedups identical re-captures and coalesces a burst of
        // snapshots for one thread down to the newest, so this expensive
        // process() runs only for content that actually changed. See
        // captureAdmission.ts. The write + event-log mirror below IS the
        // process() the gate admits; on a dedup hit it never runs and the
        // last-accepted {bac_id, revision} is returned instead.
        const result = await captureAdmission.submit(input, async () => {
          const writer = await writerForBucket(context, {
            provider: input.provider,
            url: input.threadUrl,
          });
          const written = await writer.writeCaptureEvent(input, requestId);
          // Mirror the capture as a `capture.recorded` AcceptedEvent
          // in the per-replica log so peers see it via sync. The
          // legacy `_BAC/events/` write above stays for back-compat
          // (older readers, the existing rebuild path); rebuild dedups
          // by bac_id when both sources hold the same capture.
          //
          // Carry the richer per-turn fields (markdown / formattedText /
          // modelName) plus the thread-level metadata (title) through
          // to the log payload so the chunker has the best possible
          // source. Without this, the chunker would fall back to plain
          // text — losing heading structure, lists, and code fences.
          const eventLogAppended =
            context.eventLog === undefined
              ? false
              : await context.eventLog
                  .appendServerObserved({
                    clientEventId: idempotencyKey,
                    aggregateId: written.bac_id,
                    type: CAPTURE_RECORDED,
                    payload: {
                      bac_id: written.bac_id,
                      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                      threadUrl: input.threadUrl,
                      provider: input.provider,
                      ...(input.title === undefined ? {} : { title: input.title }),
                      capturedAt: input.capturedAt,
                      turns: input.turns.map((turn) => ({
                        ordinal: turn.ordinal,
                        role: turn.role,
                        text: turn.text,
                        capturedAt: turn.capturedAt,
                        ...(turn.markdown === undefined ? {} : { markdown: turn.markdown }),
                        ...(turn.formattedText === undefined
                          ? {}
                          : { formattedText: turn.formattedText }),
                        ...(turn.modelName === undefined ? {} : { modelName: turn.modelName }),
                      })),
                    },
                  })
                  .then(() => true)
                  .catch(() => false);
          void eventLogAppended;
          // Recall ingest is owned by the contract runner →
          // recallMaterializer path. `appendServerObserved` already
          // routes the accepted event through
          // `onLocalAccepted` → `syncContractRunner.onAcceptedEvent({
          // origin: 'local' })`, which fires the recall materializer's
          // onAccepted → coalesced ingest drain. Failures are recorded
          // via the materializer's `recallActivity.recordIngestFailed`.
          // Reviewer-flagged: do NOT also schedule
          // `lifecycle.ingestIncremental` here — that was the pre-
          // contract fast path and now duplicates work, weakening the
          // single-dispatch contract. The boot-time `catchUpAll` and
          // manual `recall reingest` cover the case where the embedder
          // was offline at capture time.
          return written;
        });
        return [201, mutationResponse(result, requestId)];
      });
    },
  },
];
