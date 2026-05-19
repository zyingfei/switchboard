// W2 — which clustering produces the SERVED topic revision.
//
// Feature flag with instant rollback (release-eng guardrail): the
// idf-rkn->G cutover is a single env value, revertible by restart.
// Default starts at 'idf-rkn-split' (today's behaviour, zero live
// change); W2's auto-flip changes the default to 'leiden-cpm' ONLY
// after the acceptance gate passes. 'union-find' is the conservative
// fallback (baseline, no shadow).

export type ServedTopicProducer = 'idf-rkn-split' | 'leiden-cpm' | 'union-find';

const VALID: ReadonlySet<string> = new Set<ServedTopicProducer>([
  'idf-rkn-split',
  'leiden-cpm',
  'union-find',
]);

// W2 default. AUTO-FLIPPED to 'leiden-cpm' (W2.4) after the gate
// passed: TS-impl W0c churn = 0.013 (better than reference-G 0.026,
// ≪ E 0.327), ~54 topics, lineage continuity verified, 1249/1249
// regression. leiden-cpm@0.90 is the served topic producer.
// ROLLBACK: SIDETRACK_TOPIC_PRODUCER=idf-rkn-split + restart (or
// revert this constant).
export const DEFAULT_SERVED_TOPIC_PRODUCER: ServedTopicProducer = 'leiden-cpm';

export const SERVED_TOPIC_PRODUCER_ENV = 'SIDETRACK_TOPIC_PRODUCER';

export const resolveServedTopicProducer = (): ServedTopicProducer => {
  const raw = process.env[SERVED_TOPIC_PRODUCER_ENV]?.trim().toLowerCase();
  if (raw !== undefined && VALID.has(raw)) return raw as ServedTopicProducer;
  return DEFAULT_SERVED_TOPIC_PRODUCER;
};

// W2 step 5 — per-drain served-producer observability + the post-flip
// auto-rollback signal. Pure (no I/O). churn = label-invariant
// per-page co-membership Jaccard vs the previous served revision
// (same metric as W0c), p50/p90 over shared pages.
interface ServedTopicRevisionLike {
  readonly revisionId: string;
  readonly algorithmVersion: string;
  readonly cosineThreshold: number;
  readonly visitSimilarityRevisionId: string;
  readonly topics: readonly { readonly memberCanonicalUrls: readonly string[] }[];
  readonly lineage: readonly { readonly kind: string }[];
}

export interface ServedTopicProducerReport {
  readonly producer: ServedTopicProducer;
  readonly algorithmId: string;
  readonly cosineThreshold: number;
  readonly implementation: 'ts';
  readonly graphSpecHash: string;
  readonly topicCount: number;
  readonly coveredPages: number;
  readonly lineageContinue: number;
  readonly lineageSplit: number;
  readonly lineageMerge: number;
  readonly churnP50: number | null;
  readonly churnP90: number | null;
  readonly revisionId: string;
  readonly previousRevisionId: string | null;
}

const coMembership = (
  topics: readonly { readonly memberCanonicalUrls: readonly string[] }[],
): ReadonlyMap<string, ReadonlySet<string>> => {
  const out = new Map<string, Set<string>>();
  for (const topic of topics) {
    const set = new Set(topic.memberCanonicalUrls);
    for (const m of topic.memberCanonicalUrls) out.set(m, set);
  }
  return out;
};

export const buildServedTopicProducerReport = (
  producer: ServedTopicProducer,
  served: ServedTopicRevisionLike,
  previousActive: ServedTopicRevisionLike | null,
): ServedTopicProducerReport => {
  let coveredPages = 0;
  for (const t of served.topics) coveredPages += t.memberCanonicalUrls.length;
  let cont = 0;
  let split = 0;
  let merge = 0;
  for (const l of served.lineage) {
    if (l.kind === 'continue') cont += 1;
    else if (l.kind === 'split') split += 1;
    else if (l.kind === 'merge') merge += 1;
  }
  let churnP50: number | null = null;
  let churnP90: number | null = null;
  if (previousActive !== null) {
    const cur = coMembership(served.topics);
    const prev = coMembership(previousActive.topics);
    const shared = [...cur.keys()].filter((u) => prev.has(u));
    if (shared.length >= 5) {
      const sset = new Set(shared);
      const ch: number[] = [];
      for (const u of shared) {
        const A = new Set([...(cur.get(u) ?? [])].filter((x) => sset.has(x)));
        const B = new Set([...(prev.get(u) ?? [])].filter((x) => sset.has(x)));
        let inter = 0;
        for (const x of A) if (B.has(x)) inter += 1;
        const uni = A.size + B.size - inter;
        ch.push(uni === 0 ? 0 : 1 - inter / uni);
      }
      ch.sort((a, b) => a - b);
      churnP50 = Number(ch[Math.floor(ch.length * 0.5)]?.toFixed(4) ?? 0);
      churnP90 = Number(ch[Math.floor(ch.length * 0.9)]?.toFixed(4) ?? 0);
    }
  }
  return {
    producer,
    algorithmId: served.algorithmVersion,
    cosineThreshold: served.cosineThreshold,
    implementation: 'ts',
    graphSpecHash: served.visitSimilarityRevisionId,
    topicCount: served.topics.length,
    coveredPages,
    lineageContinue: cont,
    lineageSplit: split,
    lineageMerge: merge,
    churnP50,
    churnP90,
    revisionId: served.revisionId,
    previousRevisionId: previousActive?.revisionId ?? null,
  };
};
