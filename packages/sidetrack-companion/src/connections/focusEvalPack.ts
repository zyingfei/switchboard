import type {
  TopicVisit,
  VisitSimilarityEdge,
  VisitSimilarityRevisionInput,
} from './topicClusterer.js';

export type FocusEvalPairLabel = 'same-topic' | 'different-topic' | 'ambiguous';

export interface FocusEvalVisit extends TopicVisit {
  readonly evalCluster: string;
}

export interface FocusEvalPair {
  readonly a: string;
  readonly b: string;
  readonly label: FocusEvalPairLabel;
  readonly reason: string;
}

export interface FocusEvalPack {
  readonly visits: readonly FocusEvalVisit[];
  readonly visitSimilarity: VisitSimilarityRevisionInput;
  readonly labels: readonly FocusEvalPair[];
  readonly trueClusterByVisit: ReadonlyMap<string, string>;
}

const CLUSTERS = [
  'oracle-26ai',
  'postgres-indexing',
  'ai-decision-frameworks',
  'browser-history',
  'sidetrack-focus',
] as const;

const visitFor = (cluster: string, index: number): FocusEvalVisit => {
  const slug = `${cluster}-${String(index).padStart(2, '0')}`;
  const url = `https://eval.sidetrack.local/focus/${cluster}/${slug}`;
  return {
    canonicalUrl: url,
    title: `sidetrack_focus_eval ${cluster} research page ${String(index)}`,
    focusedWindowMs: 9_000 + index * 250,
    firstObservedAt: `2026-05-13T${String(8 + Math.floor(index / 4)).padStart(2, '0')}:00:00.000Z`,
    lastObservedAt: `2026-05-13T${String(8 + Math.floor(index / 4)).padStart(2, '0')}:05:00.000Z`,
    evalCluster: cluster,
  };
};

const pairKey = (left: string, right: string): string =>
  left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;

const edge = (fromVisitKey: string, toVisitKey: string, cosine: number): VisitSimilarityEdge => ({
  fromVisitKey,
  toVisitKey,
  cosine,
});

const pair = (a: string, b: string, label: FocusEvalPairLabel, reason: string): FocusEvalPair => ({
  a,
  b,
  label,
  reason,
});

export const buildFocusEvalPack = (): FocusEvalPack => {
  const visits = CLUSTERS.flatMap((cluster) =>
    Array.from({ length: 12 }, (_, index) => visitFor(cluster, index + 1)),
  );
  const byCluster = new Map<string, FocusEvalVisit[]>();
  for (const visit of visits) {
    const list = byCluster.get(visit.evalCluster) ?? [];
    list.push(visit);
    byCluster.set(visit.evalCluster, list);
  }

  const edges: VisitSimilarityEdge[] = [];
  for (const cluster of CLUSTERS) {
    const clusterVisits = byCluster.get(cluster) ?? [];
    for (let i = 0; i < clusterVisits.length; i += 1) {
      for (let j = i + 1; j < clusterVisits.length; j += 1) {
        const left = clusterVisits[i]!;
        const right = clusterVisits[j]!;
        const distance = j - i;
        edges.push(
          edge(left.canonicalUrl, right.canonicalUrl, 0.94 - Math.min(0.06, distance * 0.004)),
        );
      }
    }
  }

  const labels: FocusEvalPair[] = [];
  const seen = new Set<string>();
  const pushPair = (candidate: FocusEvalPair): void => {
    const key = pairKey(candidate.a, candidate.b);
    if (seen.has(key)) return;
    seen.add(key);
    labels.push(candidate);
  };

  for (const cluster of CLUSTERS) {
    const clusterVisits = byCluster.get(cluster) ?? [];
    for (
      let i = 0;
      i < clusterVisits.length && labels.filter((p) => p.label === 'same-topic').length < 80;
      i += 1
    ) {
      for (
        let j = i + 1;
        j < clusterVisits.length && labels.filter((p) => p.label === 'same-topic').length < 80;
        j += 1
      ) {
        pushPair(
          pair(
            clusterVisits[i]!.canonicalUrl,
            clusterVisits[j]!.canonicalUrl,
            'same-topic',
            `both are ${cluster}`,
          ),
        );
      }
    }
  }

  for (let leftCluster = 0; leftCluster < CLUSTERS.length; leftCluster += 1) {
    for (let rightCluster = leftCluster + 1; rightCluster < CLUSTERS.length; rightCluster += 1) {
      const leftVisits = byCluster.get(CLUSTERS[leftCluster]!) ?? [];
      const rightVisits = byCluster.get(CLUSTERS[rightCluster]!) ?? [];
      for (
        let i = 0;
        i < leftVisits.length && labels.filter((p) => p.label === 'different-topic').length < 100;
        i += 1
      ) {
        const right = rightVisits[(i + rightCluster) % rightVisits.length];
        if (right !== undefined) {
          pushPair(
            pair(
              leftVisits[i]!.canonicalUrl,
              right.canonicalUrl,
              'different-topic',
              'different eval clusters',
            ),
          );
        }
      }
    }
  }

  for (let index = 0; labels.filter((p) => p.label === 'ambiguous').length < 40; index += 1) {
    const leftCluster = CLUSTERS[index % CLUSTERS.length]!;
    const rightCluster = CLUSTERS[(index + 1) % CLUSTERS.length]!;
    const left = (byCluster.get(leftCluster) ?? [])[index % 12]!;
    const right = (byCluster.get(rightCluster) ?? [])[(index + 3) % 12]!;
    edges.push(edge(left.canonicalUrl, right.canonicalUrl, 0.855));
    pushPair(
      pair(
        left.canonicalUrl,
        right.canonicalUrl,
        'ambiguous',
        'adjacent research context but not a hard same-topic label',
      ),
    );
  }

  return {
    visits,
    visitSimilarity: {
      revisionId: 'focus-eval:sidetrack:220-pairs',
      edges: edges.sort(
        (left, right) =>
          left.fromVisitKey.localeCompare(right.fromVisitKey) ||
          left.toVisitKey.localeCompare(right.toVisitKey),
      ),
    },
    labels,
    trueClusterByVisit: new Map(visits.map((visit) => [visit.canonicalUrl, visit.evalCluster])),
  };
};

export const buildLargeCoherentFocusFixture = (): FocusEvalPack => {
  const visits = Array.from({ length: 72 }, (_, index): FocusEvalVisit => {
    const n = index + 1;
    const url = `https://eval.sidetrack.local/focus/deep-research/page-${String(n).padStart(2, '0')}`;
    return {
      canonicalUrl: url,
      title: `sidetrack_focus_eval deep research source ${String(n)}`,
      focusedWindowMs: 12_000,
      firstObservedAt: '2026-05-13T08:00:00.000Z',
      lastObservedAt: '2026-05-13T12:00:00.000Z',
      evalCluster: 'deep-research-large-coherent',
    };
  });
  const edges: VisitSimilarityEdge[] = [];
  for (let i = 0; i < visits.length; i += 1) {
    for (let j = i + 1; j < Math.min(visits.length, i + 9); j += 1) {
      edges.push(edge(visits[i]!.canonicalUrl, visits[j]!.canonicalUrl, 0.92));
    }
  }
  return {
    visits,
    visitSimilarity: { revisionId: 'focus-eval:large-coherent', edges },
    labels: visits
      .slice(1)
      .map((visit) =>
        pair(
          visits[0]!.canonicalUrl,
          visit.canonicalUrl,
          'same-topic',
          'same deep research session',
        ),
      ),
    trueClusterByVisit: new Map(visits.map((visit) => [visit.canonicalUrl, visit.evalCluster])),
  };
};
