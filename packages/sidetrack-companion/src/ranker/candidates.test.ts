import { describe, expect, it } from 'vitest';

import type {
  ConnectionEdge,
  ConnectionEdgeKind,
  ConnectionEdgeProducedBy,
} from '../connections/types.js';
import { nodeIdFor } from '../connections/types.js';
import { USER_FLOW_CONFIRMED } from '../feedback/events.js';
import { NAVIGATION_COMMITTED } from '../navigation/events.js';
import { buildExtractedPageEvidence } from '../page-evidence/extract.js';
import type { PageEvidenceExtractedRequest, VectorRef } from '../page-evidence/types.js';
import { SELECTION_COPIED } from '../snippets/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import {
  CANDIDATE_SOURCES,
  generateContentEmbeddingNeighborhoodCandidates,
  generateContentTermOverlapCandidates,
  generateCandidates,
  generateCrossReplicaContinuationCandidates,
  generateEmbeddingNeighborhoodCandidates,
  generateNavigationChainCandidates,
  generateOpenerChainCandidates,
  generateRandomUnrelatedCandidates,
  generateRecentlySkippedCandidates,
  generateSameCanonicalUrlCandidates,
  generateSameCopiedSnippetCandidates,
  generateSameRepoOrDomainCandidates,
  generateSameSearchQueryCandidates,
  generateSameTitlePathTokensCandidates,
  generateUserConfirmedCandidates,
} from './candidates.js';
import type { CandidateSource, GenerateCandidates } from './types.js';

type CandidateContext = Parameters<GenerateCandidates>[1];

const BASE_TIME = Date.parse('2026-05-07T10:00:00.000Z');
const GENERATED_AT = BASE_TIME + 3_000;

const event = (input: {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly replicaId?: string;
  readonly acceptedAtMs?: number;
}): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: input.replicaId ?? 'replica-a', seq: input.seq },
  deps: {},
  aggregateId: `agg-${String(input.seq)}`,
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs ?? BASE_TIME + input.seq * 1_000,
});

const navigationPayload = (input: {
  readonly visitId: string;
  readonly canonicalUrl: string;
  readonly openerVisitId?: string | null;
  readonly previousVisitId?: string | null;
  readonly commitTimestamp?: number;
}): unknown => ({
  payloadVersion: 1,
  visitId: input.visitId,
  url: input.canonicalUrl,
  canonicalUrl: input.canonicalUrl,
  documentId: `doc-${input.visitId}`,
  parentDocumentId: null,
  tabSessionIdHash: 'tab-a',
  windowSessionIdHash: 'window-a',
  openerVisitId: input.openerVisitId ?? null,
  previousVisitId: input.previousVisitId ?? null,
  navigationSequence: 1,
  transitionType: 'link',
  transitionQualifiers: [],
  commitTimestamp: input.commitTimestamp ?? BASE_TIME + 3_000,
});

const timelinePayload = (input: {
  readonly url: string;
  readonly title?: string;
  readonly workstreamId?: string;
  readonly observedAt?: string;
}): unknown => ({
  eventId: `timeline-${input.url}`,
  observedAt: input.observedAt ?? '2026-05-07T10:00:03.000Z',
  url: input.url,
  canonicalUrl: input.url,
  ...(input.title === undefined ? {} : { title: input.title }),
  provider: 'generic',
  transition: 'activated',
  ...(input.workstreamId === undefined ? {} : { workstreamId: input.workstreamId }),
  payloadVersion: 1,
});

const snippetPayload = (input: {
  readonly visitId: string;
  readonly selectionHash: string;
}): unknown => ({
  payloadVersion: 1,
  visitId: input.visitId,
  selectionHash: input.selectionHash,
  simhash64: 'AAAAAAAAAAA=',
  charCount: 42,
  lineCount: 2,
  contentKindHint: 'code-block',
  rawTextStored: false,
});

const context = (
  merged: readonly AcceptedEvent[] = [],
  existingEdges: readonly ConnectionEdge[] = [],
  extra: Omit<CandidateContext, 'merged' | 'existingEdges'> = {},
): CandidateContext => ({
  merged: [...merged],
  existingEdges: [...existingEdges],
  ...extra,
});

const edge = (input: {
  readonly kind: ConnectionEdgeKind;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly observedAt?: string;
  readonly producedBy?: ConnectionEdgeProducedBy;
  readonly metadata?: Record<string, unknown>;
}): ConnectionEdge => ({
  id: `edge:${input.kind}:${input.fromNodeId}:${input.toNodeId}`,
  kind: input.kind,
  fromNodeId: input.fromNodeId,
  toNodeId: input.toNodeId,
  observedAt: input.observedAt ?? '2026-05-07T10:00:03.000Z',
  producedBy: input.producedBy ?? { source: 'timeline-projection' },
  confidence: 'inferred',
  ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
});

const evidencePayload = (input: {
  readonly canonicalUrl: string;
  readonly title: string;
  readonly text: string;
}): PageEvidenceExtractedRequest => ({
  payloadVersion: 1,
  canonicalUrl: input.canonicalUrl,
  url: input.canonicalUrl,
  title: input.title,
  extractedAt: '2026-05-16T10:00:00.000Z',
  extractionSource: 'reader-mode',
  extractionPolicy: { trigger: 'attention-gate' },
  quality: 'high',
  qualitySignals: {
    extractedWordCount: 320,
    contentToDomRatio: 0.7,
    boilerplateFraction: 0.05,
    extractionStrategy: 'reader-mode',
  },
  content: {
    text: input.text,
    contentHash: `hash-${input.title.toLowerCase()}`,
    charCount: input.text.length,
  },
  storageMode: 'features_only',
});

const vectorRef = (vectorId: string, overrides: Partial<VectorRef> = {}): VectorRef => ({
  vectorId,
  modelId: 'test-e5',
  modelVersion: 'rev-a',
  dimensions: 2,
  ...overrides,
});

const expectSingleSourceCandidate = (
  generate: GenerateCandidates,
  source: CandidateSource,
  fromVisitId: string,
  toVisitId: string,
  ctx: CandidateContext,
): void => {
  expect(generate(fromVisitId, ctx)).toEqual([
    {
      fromVisitId,
      toVisitId,
      sources: [source],
      generatedAt: GENERATED_AT,
    },
  ]);
};

describe('ranker candidate generation', () => {
  it('keeps the CandidateSource registry in schema order', () => {
    expect(CANDIDATE_SOURCES).toEqual([
      'user_confirmed',
      'opener_chain',
      'navigation_chain',
      'same_canonical_url',
      'same_repo_or_domain',
      'same_search_query',
      'same_copied_snippet',
      'same_title_path_tokens',
      'embedding_neighborhood',
      'content_term_overlap',
      'content_embedding_neighborhood',
      'cross_replica_continuation',
      'random_unrelated',
      'recently_skipped',
    ]);
  });

  it('returns no candidates for empty input', () => {
    expect(generateCandidates('visit-a', context())).toEqual([]);
  });

  it('generates user_confirmed candidates', () => {
    const ctx = context([
      event({
        seq: 3,
        type: USER_FLOW_CONFIRMED,
        payload: {
          fromVisitId: 'https://alpha.test/a',
          toVisitId: 'https://bravo.test/b',
        },
      }),
    ]);

    expectSingleSourceCandidate(
      generateUserConfirmedCandidates,
      'user_confirmed',
      'https://alpha.test/a',
      'https://bravo.test/b',
      ctx,
    );
  });

  it('does not generate pair candidates from shared workstream membership alone', () => {
    const ctx = context([
      event({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: timelinePayload({
          url: 'https://alpha.test/a',
          title: 'Alpha reference',
          workstreamId: 'ws-a',
        }),
      }),
      event({
        seq: 3,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: timelinePayload({
          url: 'https://bravo.test/b',
          title: 'Bravo handbook',
          workstreamId: 'ws-a',
        }),
      }),
    ]);

    expect(generateCandidates('https://alpha.test/a', ctx)).toEqual([]);
  });

  it('still generates user_confirmed candidates for explicit pairs in a shared workstream', () => {
    const ctx = context([
      event({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: timelinePayload({
          url: 'https://alpha.test/a',
          title: 'Alpha reference',
          workstreamId: 'ws-a',
        }),
      }),
      event({
        seq: 2,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: timelinePayload({
          url: 'https://bravo.test/b',
          title: 'Bravo handbook',
          workstreamId: 'ws-a',
        }),
      }),
      event({
        seq: 3,
        type: USER_FLOW_CONFIRMED,
        payload: {
          fromVisitId: 'https://alpha.test/a',
          toVisitId: 'https://bravo.test/b',
        },
      }),
    ]);

    expectSingleSourceCandidate(
      generateCandidates,
      'user_confirmed',
      'https://alpha.test/a',
      'https://bravo.test/b',
      ctx,
    );
  });

  it('generates opener_chain candidates', () => {
    const ctx = context([
      event({
        seq: 1,
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({ visitId: 'visit-a', canonicalUrl: 'https://a.test/one' }),
      }),
      event({
        seq: 3,
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-b',
          canonicalUrl: 'https://b.test/two',
          openerVisitId: 'visit-a',
        }),
      }),
    ]);

    expectSingleSourceCandidate(
      generateOpenerChainCandidates,
      'opener_chain',
      'visit-a',
      'visit-b',
      ctx,
    );
  });

  it('generates navigation_chain candidates', () => {
    const ctx = context([
      event({
        seq: 1,
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({ visitId: 'visit-a', canonicalUrl: 'https://a.test/one' }),
      }),
      event({
        seq: 3,
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-b',
          canonicalUrl: 'https://b.test/two',
          previousVisitId: 'visit-a',
        }),
      }),
    ]);

    expectSingleSourceCandidate(
      generateNavigationChainCandidates,
      'navigation_chain',
      'visit-a',
      'visit-b',
      ctx,
    );
  });

  it('generates same_canonical_url candidates', () => {
    const ctx = context([
      event({
        seq: 1,
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({ visitId: 'visit-a', canonicalUrl: 'https://same.test/page' }),
      }),
      event({
        seq: 3,
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({ visitId: 'visit-b', canonicalUrl: 'https://same.test/page' }),
      }),
    ]);

    expectSingleSourceCandidate(
      generateSameCanonicalUrlCandidates,
      'same_canonical_url',
      'visit-a',
      'visit-b',
      ctx,
    );
  });

  it('generates same_repo_or_domain candidates', () => {
    const ctx = context([
      event({
        seq: 1,
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-a',
          canonicalUrl: 'https://github.com/zyingfei/switchboard/pull/105',
        }),
      }),
      event({
        seq: 3,
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-b',
          canonicalUrl: 'https://github.com/zyingfei/switchboard/issues/17',
        }),
      }),
    ]);

    expectSingleSourceCandidate(
      generateSameRepoOrDomainCandidates,
      'same_repo_or_domain',
      'visit-a',
      'visit-b',
      ctx,
    );
  });

  it('generates same_search_query candidates', () => {
    const ctx = context([
      event({
        seq: 1,
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-a',
          canonicalUrl: 'https://www.google.com/search?q=browser+work+graph',
        }),
      }),
      event({
        seq: 3,
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-b',
          canonicalUrl: 'https://search.example.test/search?q=browser+work+graph',
        }),
      }),
    ]);

    expectSingleSourceCandidate(
      generateSameSearchQueryCandidates,
      'same_search_query',
      'visit-a',
      'visit-b',
      ctx,
    );
  });

  it('generates same_copied_snippet candidates', () => {
    const ctx = context([
      event({
        seq: 1,
        type: SELECTION_COPIED,
        payload: snippetPayload({ visitId: 'visit-a', selectionHash: 'hash-shared' }),
      }),
      event({
        seq: 3,
        type: SELECTION_COPIED,
        payload: snippetPayload({ visitId: 'visit-b', selectionHash: 'hash-shared' }),
      }),
    ]);

    expectSingleSourceCandidate(
      generateSameCopiedSnippetCandidates,
      'same_copied_snippet',
      'visit-a',
      'visit-b',
      ctx,
    );
  });

  it('generates same_title_path_tokens candidates', () => {
    const ctx = context([
      event({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: timelinePayload({ url: 'https://alpha.test/a', title: 'Quantum ledger notes' }),
      }),
      event({
        seq: 3,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: timelinePayload({ url: 'https://bravo.test/b', title: 'Quantum timeline review' }),
      }),
    ]);

    expectSingleSourceCandidate(
      generateSameTitlePathTokensCandidates,
      'same_title_path_tokens',
      'https://alpha.test/a',
      'https://bravo.test/b',
      ctx,
    );
  });

  it('generates embedding_neighborhood candidates', () => {
    const ctx = context(
      [],
      [
        edge({
          kind: 'visit_resembles_visit',
          fromNodeId: nodeIdFor('timeline-visit', 'visit-a'),
          toNodeId: nodeIdFor('timeline-visit', 'visit-b'),
          producedBy: { source: 'visit-similarity', revisionId: 'visit-sim:v1' },
        }),
      ],
    );

    expectSingleSourceCandidate(
      generateEmbeddingNeighborhoodCandidates,
      'embedding_neighborhood',
      'visit-a',
      'visit-b',
      ctx,
    );
  });

  it('generates content_term_overlap candidates from PageEvidence when available', () => {
    const alpha = buildExtractedPageEvidence(
      evidencePayload({
        canonicalUrl: 'https://alpha.test/f16',
        title: 'F16 Minipack',
        text: 'F16 Minipack data center fabric network switch 100G '.repeat(20),
      }),
    );
    const bravo = buildExtractedPageEvidence(
      evidencePayload({
        canonicalUrl: 'https://bravo.test/fabric',
        title: 'Fabric switch',
        text: 'Minipack F16 network fabric data center architecture '.repeat(20),
      }),
    );
    const charlie = buildExtractedPageEvidence(
      evidencePayload({
        canonicalUrl: 'https://charlie.test/database',
        title: 'Database backup',
        text: 'transaction log backup recovery point objective '.repeat(20),
      }),
    );
    const ctx = context(
      [event({ seq: 3, type: 'noop', payload: {} })],
      [
        edge({
          kind: 'visit_resembles_visit',
          fromNodeId: alpha.canonicalUrl,
          toNodeId: bravo.canonicalUrl,
          producedBy: { source: 'visit-similarity', revisionId: 'visit-sim:v1' },
          metadata: { channels: { contentVector: 1 } },
        }),
      ],
      {
        pageEvidenceByCanonicalUrl: new Map([
          [alpha.canonicalUrl, alpha],
          [bravo.canonicalUrl, bravo],
          [charlie.canonicalUrl, charlie],
        ]),
      },
    );

    expect(generateContentTermOverlapCandidates(alpha.canonicalUrl, ctx)).toEqual([
      {
        fromVisitId: alpha.canonicalUrl,
        toVisitId: bravo.canonicalUrl,
        sources: ['content_term_overlap'],
        generatedAt: GENERATED_AT,
      },
    ]);
  });

  it('generates content_embedding_neighborhood candidates from compatible doc vectors', () => {
    const alpha = buildExtractedPageEvidence(
      evidencePayload({
        canonicalUrl: 'https://alpha.test/f16',
        title: 'F16 Minipack',
        text: 'F16 Minipack data center fabric network switch 100G '.repeat(20),
      }),
      undefined,
      { docEmbeddingRef: vectorRef('vec-alpha') },
    );
    const bravo = buildExtractedPageEvidence(
      evidencePayload({
        canonicalUrl: 'https://bravo.test/fabric',
        title: 'Fabric switch',
        text: 'Minipack F16 network fabric data center architecture '.repeat(20),
      }),
      undefined,
      { docEmbeddingRef: vectorRef('vec-bravo') },
    );
    const incompatible = buildExtractedPageEvidence(
      evidencePayload({
        canonicalUrl: 'https://charlie.test/fabric',
        title: 'Other fabric',
        text: 'Minipack F16 network fabric data center architecture '.repeat(20),
      }),
      undefined,
      { docEmbeddingRef: vectorRef('vec-charlie', { modelVersion: 'rev-b' }) },
    );
    const ctx = context(
      [event({ seq: 3, type: 'noop', payload: {} })],
      [
        edge({
          kind: 'visit_resembles_visit',
          fromNodeId: alpha.canonicalUrl,
          toNodeId: bravo.canonicalUrl,
          producedBy: { source: 'visit-similarity', revisionId: 'visit-sim:v1' },
          metadata: { channels: { contentVector: 1 } },
        }),
      ],
      {
        pageEvidenceByCanonicalUrl: new Map([
          [alpha.canonicalUrl, alpha],
          [bravo.canonicalUrl, bravo],
          [incompatible.canonicalUrl, incompatible],
        ]),
        evidenceVectorsByVectorId: new Map([
          ['vec-alpha', Float32Array.from([1, 0])],
          ['vec-bravo', Float32Array.from([1, 0])],
          ['vec-charlie', Float32Array.from([1, 0])],
        ]),
      },
    );

    expect(generateContentEmbeddingNeighborhoodCandidates(alpha.canonicalUrl, ctx)).toEqual([
      {
        fromVisitId: alpha.canonicalUrl,
        toVisitId: bravo.canonicalUrl,
        sources: ['content_embedding_neighborhood'],
        generatedAt: GENERATED_AT,
      },
    ]);
  });

  it('generates cross_replica_continuation candidates', () => {
    const ctx = context([
      event({
        seq: 1,
        replicaId: 'replica-a',
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-a',
          canonicalUrl: 'https://shared.test/page',
        }),
      }),
      event({
        seq: 3,
        replicaId: 'replica-b',
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-b',
          canonicalUrl: 'https://shared.test/page',
        }),
      }),
    ]);

    expectSingleSourceCandidate(
      generateCrossReplicaContinuationCandidates,
      'cross_replica_continuation',
      'visit-a',
      'visit-b',
      ctx,
    );
  });

  it('passes through explicit random_unrelated candidates for S19 inputs', () => {
    const ctx = context([
      event({
        seq: 3,
        type: 'ranker.random_unrelated',
        payload: { fromVisitId: 'visit-a', toVisitId: 'visit-z' },
      }),
    ]);

    expectSingleSourceCandidate(
      generateRandomUnrelatedCandidates,
      'random_unrelated',
      'visit-a',
      'visit-z',
      ctx,
    );
  });

  it('generates recently_skipped candidates from rejected-flow events', () => {
    const ctx = context([
      event({
        seq: 3,
        type: 'user.flow.rejected',
        payload: { fromVisitId: 'visit-a', toVisitId: 'visit-b' },
      }),
    ]);

    expectSingleSourceCandidate(
      generateRecentlySkippedCandidates,
      'recently_skipped',
      'visit-a',
      'visit-b',
      ctx,
    );
  });

  it('dedupes candidates by pair and unions sources in schema order', () => {
    const ctx = context([
      event({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: timelinePayload({
          url: 'https://alpha.test/a',
          title: 'Shared focus',
          workstreamId: 'ws-a',
        }),
      }),
      event({
        seq: 3,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: timelinePayload({
          url: 'https://bravo.test/b',
          title: 'Shared review',
          workstreamId: 'ws-a',
        }),
      }),
    ]);

    expect(generateCandidates('https://alpha.test/a', ctx)).toEqual([
      {
        fromVisitId: 'https://alpha.test/a',
        toVisitId: 'https://bravo.test/b',
        sources: ['same_title_path_tokens'],
        generatedAt: GENERATED_AT,
      },
    ]);
  });

  it('is deterministic when the merged log order changes', () => {
    const merged = [
      event({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: timelinePayload({
          url: 'https://alpha.test/a',
          title: 'Quantum ledger',
          workstreamId: 'ws-a',
        }),
      }),
      event({
        seq: 2,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: timelinePayload({
          url: 'https://bravo.test/b',
          title: 'Quantum review',
          workstreamId: 'ws-a',
        }),
      }),
      event({
        seq: 3,
        type: SELECTION_COPIED,
        payload: snippetPayload({ visitId: 'https://alpha.test/a', selectionHash: 'hash-shared' }),
      }),
      event({
        seq: 4,
        type: SELECTION_COPIED,
        payload: snippetPayload({ visitId: 'https://bravo.test/b', selectionHash: 'hash-shared' }),
      }),
    ];

    const forward = JSON.stringify(generateCandidates('https://alpha.test/a', context(merged)));
    const [first, second, third, fourth] = merged;
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      throw new Error('expected four merged events');
    }
    const shuffled = JSON.stringify(
      generateCandidates('https://alpha.test/a', context([third, first, fourth, second])),
    );

    expect(shuffled).toBe(forward);
  });
});
