// Page-content and page-evidence routes: extracted-text ingestion, evidence
// summary/extracted, tombstone, recanonicalize, and coverage.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import {
  readPageContentCoverage,
  readPageContentExtractedPayloadForEvidence,
  writePageContentExtracted,
  writePageContentTombstoned,
} from '../../page-content/store.js';
import {
  PAGE_CONTENT_EXTRACTED,
  PAGE_CONTENT_TOMBSTONED,
  type PageContentExtractedPayload,
  type PageContentTombstonedPayload,
} from '../../page-content/types.js';
import { PAGE_EVIDENCE_EXTRACTED } from '../../page-evidence/events.js';
import {
  discardQueuedBodyEvidenceUnderLock,
  enqueueBodyEvidence,
  scrubBodyEvidencePayload,
  withBodyEvidenceUrlLock,
} from '../../page-evidence/bodyEvidenceQueue.js';
import {
  readPageEvidence,
  writeExtractedPageEvidence,
  writeExtractedPageEvidenceFast,
} from '../../page-evidence/store.js';
import type {
  PageEvidenceExtractedEventPayload,
  PageEvidenceExtractedRequest,
  PageEvidenceRecord,
} from '../../page-evidence/types.js';
import {
  pageContentCoverageQuerySchema,
  pageContentExtractedSchema,
  pageContentTombstonedSchema,
  pageEvidenceExtractedSchema,
} from '../schemas.js';

import {
  HttpRouteError,
  objectRecord,
  readBody,
  requireIdempotencyKey,
  requireVaultRoot,
  runIdempotent,
} from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

const compactPageContentExtractedPayload = (
  payload: ReturnType<typeof pageContentExtractedSchema.parse>,
): PageContentExtractedPayload => ({
  payloadVersion: payload.payloadVersion,
  canonicalUrl: payload.canonicalUrl,
  url: payload.url,
  ...(payload.title === undefined ? {} : { title: payload.title }),
  ...(payload.provider === undefined ? {} : { provider: payload.provider }),
  extractedAt: payload.extractedAt,
  extractionSource: payload.extractionSource,
  extractionPolicy: {
    trigger: payload.extractionPolicy.trigger,
    ...(payload.extractionPolicy.workstreamId === undefined
      ? {}
      : { workstreamId: payload.extractionPolicy.workstreamId }),
    ...(payload.extractionPolicy.domainPolicyId === undefined
      ? {}
      : { domainPolicyId: payload.extractionPolicy.domainPolicyId }),
  },
  quality: payload.quality,
  qualitySignals: {
    extractedWordCount: payload.qualitySignals.extractedWordCount,
    contentToDomRatio: payload.qualitySignals.contentToDomRatio,
    boilerplateFraction: payload.qualitySignals.boilerplateFraction,
    extractionStrategy: payload.qualitySignals.extractionStrategy,
    ...(payload.qualitySignals.headingSignatureHash === undefined
      ? {}
      : { headingSignatureHash: payload.qualitySignals.headingSignatureHash }),
  },
  content: {
    text: payload.content.text,
    ...(payload.content.markdown === undefined ? {} : { markdown: payload.content.markdown }),
    contentHash: payload.content.contentHash,
    charCount: payload.content.charCount,
  },
  ...(payload.redaction === undefined
    ? {}
    : {
        redaction: {
          applied: payload.redaction.applied,
          rules: payload.redaction.rules,
        },
      }),
  ...(payload.dimensions === undefined ? {} : { dimensions: payload.dimensions }),
});

const compactPageEvidenceExtractedPayload = (
  payload: ReturnType<typeof pageEvidenceExtractedSchema.parse>,
): PageEvidenceExtractedRequest => ({
  ...compactPageContentExtractedPayload(payload),
  storageMode: payload.storageMode,
});

const pageEvidenceExtractedEventPayload = (
  evidence: PageEvidenceRecord,
  request: PageEvidenceExtractedRequest,
): PageEvidenceExtractedEventPayload => ({
  payloadVersion: 1,
  canonicalUrl: evidence.canonicalUrl,
  evidenceRevision: evidence.evidenceRevision,
  semanticFeatureRevision: evidence.semanticFeatureRevision,
  behaviorMetadataRevision: evidence.behaviorMetadataRevision,
  evidenceTier: evidence.evidenceTier,
  ...(evidence.content?.contentHash === undefined
    ? {}
    : { contentHash: evidence.content.contentHash }),
  storageMode: request.storageMode,
  versions: evidence.versions,
  ...(evidence.content?.quality === undefined ? {} : { quality: evidence.content.quality }),
  termCount: evidence.content?.terms.length ?? 0,
  keyphraseCount: evidence.content?.keyphrases.length ?? 0,
  entityCount: evidence.content?.entities.length ?? 0,
  ...(evidence.content?.docEmbeddingRef === undefined
    ? {}
    : {
        vectorRef: {
          modelId: evidence.content.docEmbeddingRef.modelId,
          modelVersion: evidence.content.docEmbeddingRef.modelVersion,
          dimensions: evidence.content.docEmbeddingRef.dimensions,
        },
      }),
  ...(evidence.content?.embeddingState === undefined
    ? {}
    : { embeddingState: evidence.content.embeddingState }),
  trigger: request.extractionPolicy.trigger,
});

const pageEvidenceSummaryPayload = (evidence: PageEvidenceRecord): Record<string, unknown> => ({
  tier: evidence.evidenceTier,
  evidenceRevision: evidence.evidenceRevision,
  semanticFeatureRevision: evidence.semanticFeatureRevision,
  updatedAt: evidence.updatedAt,
  termCount: evidence.content?.terms.length ?? 0,
  keyphraseCount: evidence.content?.keyphrases.length ?? 0,
  entityCount: evidence.content?.entities.length ?? 0,
  ...(evidence.content?.quality === undefined ? {} : { quality: evidence.content.quality }),
  ...(evidence.content?.docEmbeddingRef === undefined
    ? {}
    : {
        vector: {
          modelId: evidence.content.docEmbeddingRef.modelId,
          modelVersion: evidence.content.docEmbeddingRef.modelVersion,
          dimensions: evidence.content.docEmbeddingRef.dimensions,
        },
      }),
});

const compactPageContentTombstonedPayload = (
  payload: ReturnType<typeof pageContentTombstonedSchema.parse>,
): PageContentTombstonedPayload => ({
  payloadVersion: payload.payloadVersion,
  canonicalUrl: payload.canonicalUrl,
  tombstonedAt: payload.tombstonedAt,
  reason: payload.reason,
  ...(payload.contentHash === undefined ? {} : { contentHash: payload.contentHash }),
  ...(payload.dimensions === undefined ? {} : { dimensions: payload.dimensions }),
});

export const pageContentRoutes: readonly RouteDefinition[] = [
  {
    method: 'POST',
    pattern: /^\/v1\/page-content\/extracted$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const idempotencyKey = requireIdempotencyKey(request);
      const payload = compactPageContentExtractedPayload(
        pageContentExtractedSchema.parse(await readBody(request)),
      );
      return await runIdempotent(context, 'pageContentExtracted', idempotencyKey, async () => {
        const coverage = await writePageContentExtracted(vaultRoot, payload);
        const evidence = await writeExtractedPageEvidence(vaultRoot, {
          ...payload,
          storageMode: 'indexed_chunks',
        });
        if (context.eventLog !== undefined) {
          await context.eventLog.appendServerObserved({
            clientEventId: idempotencyKey,
            aggregateId: `page-content:${coverage.canonicalUrl}`,
            type: PAGE_CONTENT_EXTRACTED,
            payload: { ...payload },
          });
          await context.eventLog.appendServerObserved({
            clientEventId: `${idempotencyKey}:page-evidence`,
            aggregateId: `page-evidence:${evidence.canonicalUrl}`,
            type: PAGE_EVIDENCE_EXTRACTED,
            payload: {
              ...pageEvidenceExtractedEventPayload(evidence, {
                ...payload,
                storageMode: 'indexed_chunks',
              }),
            },
          });
        }
        return [202, { data: { coverage } }];
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/page-evidence\/summary(?:\?.*)?$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const canonicalUrl = url.searchParams.get('canonicalUrl');
      if (canonicalUrl === null || canonicalUrl.length === 0) {
        throw new HttpRouteError(
          400,
          'MISSING_PARAMETER',
          'canonicalUrl query parameter is required.',
          'GET /v1/page-evidence/summary requires a canonicalUrl query parameter.',
        );
      }
      try {
        const result = await readPageEvidence(vaultRoot, canonicalUrl);
        return [
          200,
          {
            data: {
              canonicalUrl: result.record?.canonicalUrl ?? canonicalUrl,
              pageEvidence:
                result.record === null ? null : pageEvidenceSummaryPayload(result.record),
              stale: result.stale,
              ...(result.staleReason === undefined ? {} : { staleReason: result.staleReason }),
            },
          },
        ];
      } catch (error) {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          error instanceof Error ? error.message : 'Invalid canonicalUrl.',
        );
      }
    },
  },
  {
    // Read back the ALREADY-INDEXED page text for a canonical URL:
    // { data: { canonicalUrl, title, text } } or 404 when not indexed.
    // The panel's on-demand content enrichment generates a gist from this
    // — the page is already extracted + stored at index time
    // (_BAC/page-content/raw/<hash>.json), so there is no reason to trigger
    // a SECOND live browser extract (which needs deeper page access and
    // failed with "no obtainable text" on an already-indexed page). Reuses
    // the exact reader page-evidence already uses; text only, no side
    // effects. (User-caught, 2026-07-27: "you can index the page, why do
    // you need another api?")
    method: 'GET',
    pattern: /^\/v1\/page-content\/text(?:\?.*)?$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const canonicalUrl = url.searchParams.get('canonicalUrl');
      if (canonicalUrl === null || canonicalUrl.length === 0) {
        throw new HttpRouteError(
          400,
          'MISSING_PARAMETER',
          'canonicalUrl query parameter is required.',
          'GET /v1/page-content/text requires a canonicalUrl query parameter.',
        );
      }
      const payload = await readPageContentExtractedPayloadForEvidence(vaultRoot, canonicalUrl);
      if (payload === null) {
        throw new HttpRouteError(
          404,
          'PAGE_NOT_INDEXED',
          'No indexed page content for this URL.',
          'The page has not been indexed (or its content was purged).',
        );
      }
      return [
        200,
        {
          data: {
            canonicalUrl: payload.canonicalUrl,
            ...(payload.title === undefined ? {} : { title: payload.title }),
            text: payload.content.markdown ?? payload.content.text,
          },
        },
      ];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/page-evidence\/extracted$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const idempotencyKey = requireIdempotencyKey(request);
      const payload = compactPageEvidenceExtractedPayload(
        pageEvidenceExtractedSchema.parse(await readBody(request)),
      );
      return await runIdempotent(context, 'pageEvidenceExtracted', idempotencyKey, async () => {
        const capturedPageContentPayload = compactPageContentExtractedPayload(payload);
        // Features-only auto capture becomes durable background work, so scrub
        // and minimize before either the queue OR feature record persists it.
        // Indexed/manual capture preserves its existing local-vault behavior.
        const pageContentPayload =
          payload.storageMode === 'features_only'
            ? scrubBodyEvidencePayload(capturedPageContentPayload).payload
            : capturedPageContentPayload;
        const evidencePayload: PageEvidenceExtractedRequest = {
          ...pageContentPayload,
          storageMode: payload.storageMode,
        };
        // Skip both the O(records) manifest rebuild and doc embedding
        // on the request path. The per-URL features record is written
        // immediately so /v1/page-evidence/summary can resolve on the
        // next badge poll. Doc embedding is intentionally not run on
        // the default API process; the embedder child owns that CPU.
        const { coverage, evidence, bodyEvidenceQueue } = await (async () => {
          if (payload.storageMode === 'features_only') {
            // Persist the fast feature record BEFORE making the body job visible.
            // Once the queue entry exists, a worker may immediately upgrade this
            // same record; writing features afterward could downgrade a completed
            // worker result back to features-only and strand the vector lane.
            const evidence = await writeExtractedPageEvidenceFast(vaultRoot, evidencePayload, {
              rebuildManifestAfterWrite: false,
            });
            // Auto/attention capture intentionally posts `features_only` so the
            // request path stays fast. Preserve its body in a bounded, durable,
            // latest-wins queue before returning. Admission is one atomic file
            // write; no chunking, corpus scan, or embedding runs here.
            const bodyEvidenceQueue = await enqueueBodyEvidence(vaultRoot, pageContentPayload);
            return { coverage: null, evidence, bodyEvidenceQueue };
          }
          // A manual indexed capture supersedes any older automatic body job.
          // Queue removal + both served-store writes share the worker's
          // per-URL lock, so an in-flight stale worker is ordered wholly before
          // or after this newer capture and can never overwrite it afterward.
          return await withBodyEvidenceUrlLock(
            vaultRoot,
            pageContentPayload.canonicalUrl,
            async () => {
              await discardQueuedBodyEvidenceUnderLock(vaultRoot, pageContentPayload.canonicalUrl);
              const coverage = await writePageContentExtracted(vaultRoot, pageContentPayload);
              const evidence = await writeExtractedPageEvidenceFast(vaultRoot, evidencePayload, {
                rebuildManifestAfterWrite: false,
              });
              return { coverage, evidence, bodyEvidenceQueue: null };
            },
          );
        })();
        // Doc embedding is NOT run on the request path. The record is
        // written content-tier with embeddingState:'missing'; the
        // off-main-loop background-embedding lane (page-evidence/
        // backgroundEmbeddingLane.ts, wired in runtime/companion.ts) drains
        // that backlog in bounded idle batches through the embedder child.
        // The prior setTimeout(0) inline path ran ONNX/CoreML on the API
        // process — the exact main-loop CPU that kept
        // SIDETRACK_PAGE_EVIDENCE_BACKGROUND_EMBEDDING pinned OFF. The flag
        // now gates the lane, not this handler.
        if (context.eventLog !== undefined) {
          if (coverage !== null) {
            await context.eventLog.appendServerObserved({
              clientEventId: `${idempotencyKey}:page-content`,
              aggregateId: `page-content:${coverage.canonicalUrl}`,
              type: PAGE_CONTENT_EXTRACTED,
              payload: { ...pageContentPayload },
            });
          }
          await context.eventLog.appendServerObserved({
            clientEventId: `${idempotencyKey}:page-evidence`,
            aggregateId: `page-evidence:${evidence.canonicalUrl}`,
            type: PAGE_EVIDENCE_EXTRACTED,
            payload: { ...pageEvidenceExtractedEventPayload(evidence, evidencePayload) },
          });
        }
        return [
          202,
          {
            data: {
              evidence,
              ...(coverage === null ? {} : { coverage }),
              ...(bodyEvidenceQueue === null ? {} : { bodyEvidenceQueue }),
            },
          },
        ];
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/page-content\/tombstone$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const idempotencyKey = requireIdempotencyKey(request);
      const payload = compactPageContentTombstonedPayload(
        pageContentTombstonedSchema.parse(await readBody(request)),
      );
      return await runIdempotent(context, 'pageContentTombstone', idempotencyKey, async () => {
        const coverage = await withBodyEvidenceUrlLock(
          vaultRoot,
          payload.canonicalUrl,
          async () => {
            // Remove pending/dead-letter work before publishing the tombstone
            // while holding the same lock the worker checks before writing.
            await discardQueuedBodyEvidenceUnderLock(vaultRoot, payload.canonicalUrl);
            return await writePageContentTombstoned(vaultRoot, payload);
          },
        );
        if (context.eventLog !== undefined) {
          await context.eventLog.appendServerObserved({
            clientEventId: idempotencyKey,
            aggregateId: `page-content:${coverage.canonicalUrl}`,
            type: PAGE_CONTENT_TOMBSTONED,
            payload: { ...payload },
          });
        }
        return [202, { data: { coverage } }];
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/page-content\/recanonicalize$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const body = await readBody(request);
      const record = objectRecord(body);
      const canonicalUrl =
        typeof body === 'string'
          ? body
          : typeof record?.['canonicalUrl'] === 'string'
            ? record['canonicalUrl']
            : undefined;
      if (canonicalUrl === undefined || canonicalUrl.trim().length === 0) {
        throw new HttpRouteError(
          400,
          'MISSING_PARAMETER',
          'canonicalUrl is required.',
          'POST /v1/page-content/recanonicalize requires a canonicalUrl string body.',
        );
      }
      const coverage = await withBodyEvidenceUrlLock(vaultRoot, canonicalUrl, async () => {
        // Privacy/delete wins over queued background work. Queue removal and
        // the tombstone write are one per-URL critical section shared with the
        // worker's pre-write identity check.
        await discardQueuedBodyEvidenceUnderLock(vaultRoot, canonicalUrl);
        return await writePageContentTombstoned(vaultRoot, {
          payloadVersion: 1,
          canonicalUrl,
          tombstonedAt: new Date().toISOString(),
          reason: 'user-delete',
          dimensions: { source: 'recanonicalize' },
        });
      });
      return [200, { data: { tombstoned: true, canonicalUrl: coverage.canonicalUrl } }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/page-content\/coverage(?:\?.*)?$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = pageContentCoverageQuerySchema.parse({
        canonicalUrl: url.searchParams.get('canonicalUrl') ?? '',
      });
      const coverage = await readPageContentCoverage(vaultRoot, query.canonicalUrl);
      return [200, { data: coverage }];
    },
  },
];
