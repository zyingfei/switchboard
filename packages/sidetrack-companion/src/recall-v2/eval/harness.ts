// Recall v2 — eval harness.
//
// Builds a temp vault from a `Fixture` spec, runs the recall pipeline
// with a deterministic stub embedder, returns the result list +
// computed metrics. Used by index.test.ts (vitest) AND by the
// `eval:recall` script (printable metric table).

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writePageContentExtracted } from '../../page-content/store.js';
import { writeExtractedPageEvidenceFast } from '../../page-evidence/store.js';
import { writeSemanticRecallPool } from '../../recall/semanticRecallPool.js';
import { runRecall, type EmbedFn } from '../pipeline.js';
import type { RecallCandidate, RecallRequest, RecallResponse } from '../types.js';
import {
  duplicateRateAtK,
  forbiddenHitRate,
  mrr,
  ndcgAtK,
  percentile,
  recallAtK,
  selfHitRate,
  sourceDiversityAtK,
} from './metrics.js';

/** Test-only doc shape used by fixtures. Either `body` or just title+url. */
export interface FixtureDoc {
  readonly url: string;
  readonly title: string;
  /** Body text — when omitted the doc is timeline-visit-only (no body extracted). */
  readonly body?: string;
  /** First-seen ISO; defaults to now-30d so freshness decay applies sensibly. */
  readonly firstSeenAt?: string;
  readonly lastSeenAt?: string;
  /** Synthetic embedding (length must match the fixture's `embeddingDim`).
   *  When omitted the doc is NOT indexed in the semantic pool. */
  readonly embedding?: readonly number[];
}

export interface FixtureChat {
  /** bac_id / thread id. */
  readonly threadId: string;
  readonly title: string;
  /** First user-turn text — used for chat-turn lexical matching. */
  readonly firstUserTurn: string;
  readonly capturedAt: string;
  readonly embedding?: readonly number[];
}

export interface Fixture {
  readonly name: string;
  readonly description: string;
  readonly selectionText: string;
  /** Synthetic embedding for the SELECTION (length must match embeddingDim). */
  readonly selectionEmbedding: readonly number[];
  readonly currentUrl?: string;
  readonly activeChatBacIds?: readonly string[];
  readonly docs: readonly FixtureDoc[];
  readonly chats?: readonly FixtureChat[];

  readonly expected: {
    readonly mustInclude: readonly string[];
    readonly shouldInclude?: readonly string[];
    readonly forbidden?: readonly string[];
    /** Optional per-URL labels for nDCG. Defaults to must=3, should=2. */
    readonly labels?: ReadonlyMap<string, number>;
  };

  readonly assertions: {
    /** K for Recall@K and forbidden-hit@K. */
    readonly recallAtK?: number;
    readonly minRecall?: number;
    readonly minNdcg?: number;
    readonly minMrr?: number;
    readonly maxForbiddenRate?: number;
    readonly maxSelfRate?: number;
    readonly maxDuplicateRate?: number;
    readonly minSourceDiversity?: number;
    readonly currentUrlDropped?: boolean;
    /** Skip recall/MRR/nDCG checks — this fixture tests a different
     *  axis (e.g. source-diversity, suppression) and the must_include
     *  list isn't the real assertion. The invariant gate (forbidden /
     *  self / duplicate) still applies. */
    readonly skipRecallChecks?: boolean;
  };
  /** XFAIL — known gap with documented reason. When set, ratchet
   *  regressions (Recall@5, MRR, nDCG dropping vs baseline) log as
   *  warnings instead of failing the gate. Invariants (forbidden,
   *  self, duplicate) ALWAYS apply regardless of xfail. */
  readonly xfail?: {
    readonly reason: string;
    /** Optional issue / ticket id for traceability. */
    readonly trackedAs?: string;
  };

  readonly embeddingDim?: number;
  /** Defaults to a fixed wall-clock so freshness assertions stay stable. */
  readonly now?: number;
}

export interface FixtureReport {
  readonly fixture: string;
  readonly results: readonly RecallCandidate[];
  readonly metrics: {
    readonly recallAt5: number;
    readonly recallAt10: number;
    readonly recallAt20: number;
    readonly mrr: number;
    readonly ndcgAt10: number;
    readonly selfHitAt10: number;
    readonly forbiddenHitAt5: number;
    readonly duplicateRateAt10: number;
    readonly sourceDiversityAt5: number;
    readonly latencyP50Ms: number;
    readonly latencyP95Ms: number;
  };
  /** Combined gate verdict — empty array = pass. */
  readonly assertionFailures: readonly string[];
  /** Invariant failures (forbidden/self/duplicate/current-page) —
   *  ALWAYS fail the gate even if the fixture is xfail. */
  readonly invariantFailures: readonly string[];
  /** Ratchet failures (recall/MRR/nDCG) — converted to warnings when
   *  the fixture is xfail. */
  readonly ratchetFailures: readonly string[];
  /** Present when the fixture is xfail. */
  readonly xfail?: {
    readonly reason: string;
    readonly trackedAs?: string;
  };
}

const labelsFromExpected = (expected: Fixture['expected']): ReadonlyMap<string, number> => {
  if (expected.labels !== undefined) return expected.labels;
  const map = new Map<string, number>();
  for (const url of expected.mustInclude) map.set(url, 3);
  for (const url of expected.shouldInclude ?? []) {
    if (!map.has(url)) map.set(url, 2);
  }
  return map;
};

const DEFAULT_DIM = 8;

/** Build a deterministic stub embedder from a (text → vector) lookup
 *  table. Texts not in the table get a zero vector (so they
 *  contribute nothing to semantic-query cosine ranking). */
const makeStubEmbedder = (lookup: ReadonlyMap<string, Float32Array>): EmbedFn =>
  async (texts) =>
    texts.map((t) => lookup.get(t) ?? new Float32Array(DEFAULT_DIM));

const padEmbedding = (vec: readonly number[], dim: number): Float32Array => {
  const out = new Float32Array(dim);
  for (let i = 0; i < Math.min(vec.length, dim); i += 1) out[i] = vec[i]!;
  return out;
};

/** Write a single doc into the vault. Always creates a page-evidence
 *  row (so timeline-visit can find it). Adds page-content body when
 *  `doc.body` present. Vectors are NOT written here — they're written
 *  in bulk via writeSemanticRecallPool. */
const writeFixtureDoc = async (
  vaultRoot: string,
  doc: FixtureDoc,
  defaultFirstSeen: string,
): Promise<void> => {
  const firstSeen = doc.firstSeenAt ?? defaultFirstSeen;
  const lastSeen = doc.lastSeenAt ?? firstSeen;
  // Page-evidence row (titles + URL only; timeline-visit reads from here).
  await writeExtractedPageEvidenceFast(
    vaultRoot,
    {
      payloadVersion: 1,
      canonicalUrl: doc.url,
      url: doc.url,
      title: doc.title,
      extractedAt: lastSeen,
      extractionSource: 'reader-mode',
      extractionPolicy: { trigger: 'manual' },
      quality: 'high',
      qualitySignals: {
        extractedWordCount: doc.body !== undefined ? doc.body.split(/\s+/).length : 4,
        contentToDomRatio: 0.7,
        boilerplateFraction: 0.1,
        extractionStrategy: 'reader-mode',
      },
      content: {
        text: doc.body ?? doc.title,
        contentHash: `hash-${doc.url}`,
        charCount: (doc.body ?? doc.title).length,
      },
      storageMode: doc.body !== undefined ? 'indexed_chunks' : 'features_only',
    },
    { embeddingsEnabled: false, rebuildManifestAfterWrite: false },
  );
  if (doc.body !== undefined) {
    // Body-indexed: also write the page-content record so the page-
    // content lexical generator can hit it.
    await writePageContentExtracted(vaultRoot, {
      payloadVersion: 1,
      canonicalUrl: doc.url,
      url: doc.url,
      title: doc.title,
      extractedAt: lastSeen,
      extractionSource: 'reader-mode',
      extractionPolicy: { trigger: 'manual' },
      quality: 'high',
      qualitySignals: {
        extractedWordCount: doc.body.split(/\s+/).length,
        contentToDomRatio: 0.7,
        boilerplateFraction: 0.1,
        extractionStrategy: 'reader-mode',
      },
      content: {
        text: doc.body,
        contentHash: `hash-${doc.url}`,
        charCount: doc.body.length,
      },
    });
  }
};

/** Build the semantic pool from the fixture's vector-bearing docs. */
const writeFixturePool = async (
  vaultRoot: string,
  docs: readonly FixtureDoc[],
  dim: number,
  modelId: string,
): Promise<void> => {
  const withVec = docs.filter((d) => d.embedding !== undefined);
  if (withVec.length === 0) return;
  // Write the pool itself (clusters + neighbours): single cluster, no
  // neighbours (we use query-anchored expansion which reads the
  // sidecar vector store, not the cluster graph).
  await writeSemanticRecallPool(vaultRoot, {
    signature: 'fixture',
    modelId,
    featureVersion: 3,
    producedAtMs: Date.now(),
    entryCount: withVec.length,
    clusterCount: 1,
    byUrl: Object.fromEntries(
      withVec.map((d) => [
        d.url,
        {
          canonicalUrl: d.url,
          clusterId: 'fixture-cluster',
          neighbors: [],
          textHash: `hash-${d.url}`,
        },
      ]),
    ),
  });
  // Write the sidecar vector store (this is what expandSemanticByQuery
  // reads). Vault path: _BAC/recall/semantic-pool/vectors.json.
  const vectorsPath = join(vaultRoot, '_BAC', 'recall', 'semantic-pool', 'vectors.json');
  await mkdir(join(vaultRoot, '_BAC', 'recall', 'semantic-pool'), { recursive: true });
  const byUrl: Record<string, number[]> = {};
  for (const d of withVec) {
    const padded = padEmbedding(d.embedding!, dim);
    // Match the production writer: round to 6dp + store as plain numbers.
    byUrl[d.url] = Array.from(padded, (x) => Number(x.toFixed(6)));
  }
  await writeFile(
    vectorsPath,
    `${JSON.stringify({ modelId, byUrl })}\n`,
    'utf8',
  );
};

/** Run one fixture end-to-end and produce a metrics report. */
export const runFixture = async (fixture: Fixture): Promise<FixtureReport> => {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'recall-v2-eval-'));
  const dim = fixture.embeddingDim ?? DEFAULT_DIM;
  const defaultFirstSeen = new Date(
    (fixture.now ?? Date.now()) - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  try {
    // Populate.
    for (const doc of fixture.docs) {
      await writeFixtureDoc(vaultRoot, doc, defaultFirstSeen);
    }
    // The MODEL_ID used by readSemanticRecallVectorStore must match
    // what we write to vectors.json. Use the production MODEL_ID so
    // the pipeline reads the store back.
    const { MODEL_ID } = await import('../../recall/embedder.js');
    await writeFixturePool(vaultRoot, fixture.docs, dim, MODEL_ID);

    // Build the embedder lookup: selection text → its vector; each
    // chat first-user-turn → its vector (so the chat-turn vector
    // tier has something to match).
    const lookup = new Map<string, Float32Array>();
    lookup.set(fixture.selectionText, padEmbedding(fixture.selectionEmbedding, dim));
    for (const c of fixture.chats ?? []) {
      if (c.embedding !== undefined) {
        lookup.set(c.firstUserTurn, padEmbedding(c.embedding, dim));
      }
    }
    const embed = makeStubEmbedder(lookup);

    // Run the pipeline.
    const req: RecallRequest = {
      q: fixture.selectionText,
      limit: 20,
      perSourceLimit: 20,
      ...(fixture.currentUrl === undefined ? {} : { session: { currentUrl: fixture.currentUrl } }),
      ...(fixture.activeChatBacIds === undefined
        ? {}
        : {
            session: {
              ...(fixture.currentUrl === undefined ? {} : { currentUrl: fixture.currentUrl }),
              activeChatBacIds: fixture.activeChatBacIds,
            },
            suppression: { suppressActiveChatBacIds: fixture.activeChatBacIds },
          }),
      strategy: { debug: true },
    };
    const latencies: number[] = [];
    let response: RecallResponse | undefined;
    // 3 trials so P50/P95 are stable; warm-up amortizes the SQLite
    // open cost (no SQLite in Phase 1; this is here for forward-compat).
    for (let i = 0; i < 3; i += 1) {
      const start = Date.now();
      response = await runRecall(
        { vaultRoot, embed, now: () => fixture.now ?? Date.now() },
        req,
      );
      latencies.push(Date.now() - start);
    }
    const results = response!.results;

    // Metrics.
    const must = new Set(fixture.expected.mustInclude);
    const forb = new Set(fixture.expected.forbidden ?? []);
    const labels = labelsFromExpected(fixture.expected);
    const active = new Set(fixture.activeChatBacIds ?? []);
    const metrics: FixtureReport['metrics'] = {
      recallAt5: recallAtK(results, must, 5),
      recallAt10: recallAtK(results, must, 10),
      recallAt20: recallAtK(results, must, 20),
      mrr: mrr(results, must),
      ndcgAt10: ndcgAtK(results, labels, 10),
      selfHitAt10: selfHitRate(results, active, 10),
      forbiddenHitAt5: forbiddenHitRate(results, forb, 5),
      duplicateRateAt10: duplicateRateAtK(results, 10),
      sourceDiversityAt5: sourceDiversityAtK(results, 5),
      latencyP50Ms: percentile(latencies, 50),
      latencyP95Ms: percentile(latencies, 95),
    };

    // Assertion failures bucketed into:
    //   invariants — ALWAYS enforced (forbidden/self/duplicate/current-page).
    //                Even xfail fixtures must clear these.
    //   ratchet    — recall/MRR/nDCG; baseline-compared elsewhere.
    //                Failure here means below target — xfail allows
    //                this to log as warning instead of fail.
    //   skippable  — fixture opted out via assertions.skipRecallChecks
    //                (e.g. source-diversity, which tests a different
    //                axis than recall).
    const a = fixture.assertions;
    const skipRecall = a.skipRecallChecks === true;
    const invariantFails: string[] = [];
    const ratchetFails: string[] = [];
    const k = a.recallAtK ?? 5;
    const recallVal =
      k === 5 ? metrics.recallAt5 : k === 10 ? metrics.recallAt10 : metrics.recallAt20;
    if (!skipRecall && a.minRecall !== undefined && recallVal < a.minRecall) {
      ratchetFails.push(`Recall@${k} = ${recallVal.toFixed(2)} < ${a.minRecall}`);
    }
    if (!skipRecall && a.minNdcg !== undefined && metrics.ndcgAt10 < a.minNdcg) {
      ratchetFails.push(`nDCG@10 = ${metrics.ndcgAt10.toFixed(2)} < ${a.minNdcg}`);
    }
    if (!skipRecall && a.minMrr !== undefined && metrics.mrr < a.minMrr) {
      ratchetFails.push(`MRR = ${metrics.mrr.toFixed(2)} < ${a.minMrr}`);
    }
    // INVARIANTS — never gated by xfail. These are correctness
    // contracts, not quality targets.
    if (a.maxForbiddenRate !== undefined && metrics.forbiddenHitAt5 > a.maxForbiddenRate) {
      invariantFails.push(
        `forbidden-hit@5 = ${metrics.forbiddenHitAt5.toFixed(2)} > ${a.maxForbiddenRate}`,
      );
    }
    if (a.maxSelfRate !== undefined && metrics.selfHitAt10 > a.maxSelfRate) {
      invariantFails.push(`self-hit@10 = ${metrics.selfHitAt10.toFixed(2)} > ${a.maxSelfRate}`);
    }
    if (a.maxDuplicateRate !== undefined && metrics.duplicateRateAt10 > a.maxDuplicateRate) {
      invariantFails.push(
        `dup@10 = ${metrics.duplicateRateAt10.toFixed(2)} > ${a.maxDuplicateRate}`,
      );
    }
    if (a.minSourceDiversity !== undefined && metrics.sourceDiversityAt5 < a.minSourceDiversity) {
      // Source-diversity is a QUALITY target, not a correctness
      // invariant — xfail can suppress it (e.g. source-diversity
      // fixture's documented quota-fusion gap).
      ratchetFails.push(
        `sourceDiv@5 = ${metrics.sourceDiversityAt5} < ${a.minSourceDiversity}`,
      );
    }
    if (a.currentUrlDropped === true && fixture.currentUrl !== undefined) {
      const inTop = results.some((r) => r.canonicalUrl === fixture.currentUrl);
      if (inTop) invariantFails.push(`current URL not dropped: ${fixture.currentUrl}`);
    }
    // Combined: invariants always count; ratchet only counts when not xfail.
    const fails =
      fixture.xfail !== undefined ? invariantFails : [...invariantFails, ...ratchetFails];

    return {
      fixture: fixture.name,
      results,
      metrics,
      assertionFailures: fails,
      invariantFailures: invariantFails,
      ratchetFailures: ratchetFails,
      ...(fixture.xfail === undefined ? {} : { xfail: fixture.xfail }),
    };
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
};

/** Format a metric table row for printable output. */
export const formatReport = (r: FixtureReport): string => {
  const m = r.metrics;
  const status = r.assertionFailures.length === 0 ? '✓' : '✗';
  return (
    `${status} ${r.fixture.padEnd(30)} ` +
    `R@5=${m.recallAt5.toFixed(2)} ` +
    `nDCG@10=${m.ndcgAt10.toFixed(2)} ` +
    `MRR=${m.mrr.toFixed(2)} ` +
    `forb=${m.forbiddenHitAt5.toFixed(2)} ` +
    `self=${m.selfHitAt10.toFixed(2)} ` +
    `dup=${m.duplicateRateAt10.toFixed(2)} ` +
    `div=${m.sourceDiversityAt5} ` +
    `P50=${m.latencyP50Ms.toFixed(0)}ms ` +
    `P95=${m.latencyP95Ms.toFixed(0)}ms`
  );
};
