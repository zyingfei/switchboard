// Freeze-safe observability — the "Intelligence" readout in
// Settings → Diagnostics. It is a LIVING VIEW of the connection matrix
// between the built ML/recommendation subsystems and what is actually
// serving, drawn ENTIRELY from fields the companion already materializes
// on GET /v1/system/health (no new scans, no new endpoints):
//
//   doc-vector coverage → workGraph.recall.canonicalVectorCounts
//                         (documentVectorCount / chunkVectorCount)
//   sim-edge count      → workGraph.impressionLog is action liveness; the
//                         structural edge counts live on the ranker
//                         augmentation (rankerSourceEdgeCount /
//                         closestVisitEdgeCount) and, as a fallback, the
//                         feedback edge totals.
//   last drain          → sync.materializers.connections.lastSuccessAt
//                         (the connections IVM drain that rebuilds edges)
//   impressions         → workGraph.impressionLog.{servedCount,actionCount}
//                         — the recall.served / recall.action loop this
//                         work verified end-to-end.
//
// Every field is optional and defensively read: an older companion that
// omits a block renders that metric as "—" rather than throwing. This
// mirrors HealthPanel's own guard discipline (it consumes the same
// /v1/system/health shape).

export interface IntelligenceMetric {
  readonly key: 'docVectors' | 'simEdges' | 'lastDrain' | 'impressions';
  readonly label: string;
  /** Primary value, already formatted for display ("1,275", "3h ago"). */
  readonly value: string;
  /** Secondary detail shown muted beside the value. */
  readonly detail?: string;
  /** Rough connectivity state driving the dot colour. */
  readonly state: 'live' | 'idle' | 'unknown';
  /** Longer hover explanation of where the number comes from. */
  readonly title: string;
}

export interface IntelligenceSummary {
  readonly metrics: readonly IntelligenceMetric[];
  /** True when the companion returned a parseable health payload. */
  readonly available: boolean;
}

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const formatCount = (n: number): string => n.toLocaleString('en-US');

/** Relative "Xh ago" / "Xm ago" for a drain timestamp. `nowMs` is
 * injectable so the formatting is deterministic in tests. */
export const formatRelativeMs = (iso: string, nowMs: number): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const deltaMs = Math.max(0, nowMs - then);
  const min = Math.floor(deltaMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${String(min)}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${String(hr)}h ago`;
  const days = Math.floor(hr / 24);
  return `${String(days)}d ago`;
};

/** Parse the raw /v1/system/health payload (data envelope or bare) into
 * the four Intelligence metrics. Pure + defensive: unknown shape yields
 * `available: false` with all metrics rendered "—". */
export const intelligenceSummaryFromHealth = (
  raw: unknown,
  nowMs: number = Date.now(),
): IntelligenceSummary => {
  const envelope = asRecord(raw);
  const data = asRecord(envelope?.['data']) ?? envelope;
  if (data === undefined) {
    return { metrics: emptyMetrics(), available: false };
  }
  const workGraph = asRecord(data['workGraph']);
  const recall = asRecord(workGraph?.['recall']);
  const vectorCounts = asRecord(recall?.['canonicalVectorCounts']);
  const ranker = asRecord(workGraph?.['ranker']);
  const augmentation = asRecord(ranker?.['augmentation']);
  const feedback = asRecord(workGraph?.['feedback']);
  const impressionLog = asRecord(workGraph?.['impressionLog']);
  const sync = asRecord(data['sync']);
  const materializers = asRecord(sync?.['materializers']);
  const connections = asRecord(materializers?.['connections']);

  // --- doc-vector coverage ---
  const docVectors = asNumber(vectorCounts?.['documentVectorCount']);
  const chunkVectors = asNumber(vectorCounts?.['chunkVectorCount']);
  const docMetric: IntelligenceMetric =
    docVectors === undefined
      ? unknownMetric('docVectors', 'Doc vectors', 'Indexed page/document vectors backing recall.')
      : {
          key: 'docVectors',
          label: 'Doc vectors',
          value: formatCount(docVectors),
          ...(chunkVectors === undefined ? {} : { detail: `${formatCount(chunkVectors)} chunks` }),
          state: docVectors > 0 ? 'live' : 'idle',
          title:
            'Page/document vectors indexed in the recall store (workGraph.recall.canonicalVectorCounts). ' +
            'These back content-similarity and the /v2 recall lanes.',
        };

  // --- sim-edge count --- prefer the ranker augmentation's structural
  // edge counts; fall back to the feedback edge totals when the
  // augmentation block is absent/zeroed (older companion or pre-augment).
  const rankerSourceEdges = asNumber(augmentation?.['rankerSourceEdgeCount']);
  const closestVisitEdges = asNumber(augmentation?.['closestVisitEdgeCount']);
  const feedbackActions = asNumber(feedback?.['actionCount']);
  const simEdgeValue =
    rankerSourceEdges !== undefined && rankerSourceEdges > 0
      ? rankerSourceEdges
      : closestVisitEdges !== undefined && closestVisitEdges > 0
        ? closestVisitEdges
        : undefined;
  const simMetric: IntelligenceMetric =
    simEdgeValue !== undefined
      ? {
          key: 'simEdges',
          label: 'Sim edges',
          value: formatCount(simEdgeValue),
          state: 'live',
          title:
            'Structural similarity/visit edges the ranker augments over ' +
            '(workGraph.ranker.augmentation). Zero here is expected when page ' +
            'engagement access is off — visit-similarity never fires.',
        }
      : {
          key: 'simEdges',
          label: 'Sim edges',
          value: '0',
          ...(feedbackActions === undefined
            ? {}
            : { detail: `${formatCount(feedbackActions)} fb actions` }),
          // 0 sim-edges is the known page-access-off state, not "no data".
          state:
            rankerSourceEdges === undefined && closestVisitEdges === undefined ? 'unknown' : 'idle',
          title:
            'No structural similarity edges are augmenting the ranker. On this ' +
            'vault that is the page-access-off state: visit-similarity needs ≥5s ' +
            'focused engagement, which needs Deeper page access.',
        };

  // --- last drain ---
  const lastDrainIso = asString(connections?.['lastSuccessAt']);
  const drainStatus = asString(connections?.['status']);
  const drainMetric: IntelligenceMetric =
    lastDrainIso === undefined
      ? unknownMetric(
          'lastDrain',
          'Last drain',
          'When the connections materializer last rebuilt the graph.',
        )
      : {
          key: 'lastDrain',
          label: 'Last drain',
          value: formatRelativeMs(lastDrainIso, nowMs),
          ...(drainStatus === undefined ? {} : { detail: drainStatus }),
          state: drainStatus === 'healthy' || drainStatus === undefined ? 'live' : 'idle',
          title:
            'Last successful connections IVM drain (sync.materializers.connections.lastSuccessAt) — ' +
            'the pass that rebuilds visit/link/similarity edges.',
        };

  // --- impressions collected ---
  const servedCount = asNumber(impressionLog?.['servedCount']);
  const actionCount = asNumber(impressionLog?.['actionCount']);
  const impressionsMetric: IntelligenceMetric =
    servedCount === undefined
      ? unknownMetric(
          'impressions',
          'Impressions',
          'recall.served impressions collected for ranker training.',
        )
      : {
          key: 'impressions',
          label: 'Impressions',
          value: formatCount(servedCount),
          ...(actionCount === undefined
            ? {}
            : { detail: `${formatCount(actionCount)} actions` }),
          state: servedCount > 0 ? 'live' : 'idle',
          title:
            'recall.served impressions collected, with joined recall.action gestures ' +
            '(workGraph.impressionLog). This is the training-signal loop feeding the ranker.',
        };

  return {
    metrics: [docMetric, simMetric, drainMetric, impressionsMetric],
    available: true,
  };
};

const unknownMetric = (
  key: IntelligenceMetric['key'],
  label: string,
  title: string,
): IntelligenceMetric => ({ key, label, value: '—', state: 'unknown', title });

const emptyMetrics = (): readonly IntelligenceMetric[] => [
  unknownMetric('docVectors', 'Doc vectors', 'Indexed page/document vectors backing recall.'),
  unknownMetric('simEdges', 'Sim edges', 'Structural similarity edges augmenting the ranker.'),
  unknownMetric('lastDrain', 'Last drain', 'When the connections materializer last drained.'),
  unknownMetric('impressions', 'Impressions', 'recall.served impressions collected.'),
];
