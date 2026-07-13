import { describe, expect, it } from 'vitest';

import { formatRelativeMs, intelligenceSummaryFromHealth } from './intelligenceSummary';

// Mirrors the live-rig GET /v1/system/health shape (data envelope).
const LIVE_HEALTH = {
  data: {
    workGraph: {
      recall: {
        canonicalVectorCounts: { documentVectorCount: 1275, chunkVectorCount: 1234 },
      },
      ranker: {
        augmentation: { rankerSourceEdgeCount: 0, closestVisitEdgeCount: 0 },
      },
      feedback: { actionCount: 746, positiveLabelCount: 590, negativeLabelCount: 2094 },
      impressionLog: {
        servedCount: 1442,
        actionCount: 65,
        actionsByKind: { click: 59, open_new_tab: 5, flow_confirm: 1 },
      },
    },
    sync: {
      materializers: {
        connections: { status: 'healthy', lastSuccessAt: '2026-07-13T07:18:33.144Z' },
      },
    },
  },
};

const NOW = Date.parse('2026-07-13T10:18:33.144Z'); // 3h after last drain

describe('intelligenceSummaryFromHealth', () => {
  it('parses the four metrics from a live health payload', () => {
    const s = intelligenceSummaryFromHealth(LIVE_HEALTH, NOW);
    expect(s.available).toBe(true);
    const byKey = Object.fromEntries(s.metrics.map((m) => [m.key, m]));

    expect(byKey['docVectors']?.value).toBe('1,275');
    expect(byKey['docVectors']?.detail).toBe('1,234 chunks');
    expect(byKey['docVectors']?.state).toBe('live');

    // 0 sim-edges is the known page-access-off idle state, not "unknown".
    expect(byKey['simEdges']?.value).toBe('0');
    expect(byKey['simEdges']?.state).toBe('idle');

    expect(byKey['lastDrain']?.value).toBe('3h ago');
    expect(byKey['lastDrain']?.detail).toBe('healthy');
    expect(byKey['lastDrain']?.state).toBe('live');

    expect(byKey['impressions']?.value).toBe('1,442');
    expect(byKey['impressions']?.detail).toBe('65 actions');
    expect(byKey['impressions']?.state).toBe('live');
  });

  it('prefers a non-zero ranker source edge count for sim-edges', () => {
    const health = {
      data: {
        ...LIVE_HEALTH.data,
        workGraph: {
          ...LIVE_HEALTH.data.workGraph,
          ranker: { augmentation: { rankerSourceEdgeCount: 1487, closestVisitEdgeCount: 12 } },
        },
      },
    };
    const s = intelligenceSummaryFromHealth(health, NOW);
    const sim = s.metrics.find((m) => m.key === 'simEdges');
    expect(sim?.value).toBe('1,487');
    expect(sim?.state).toBe('live');
  });

  it('reports available=false and dashes for a junk / empty payload', () => {
    const s = intelligenceSummaryFromHealth(null);
    expect(s.available).toBe(false);
    expect(s.metrics.map((m) => m.value)).toEqual(['—', '—', '—', '—']);
    expect(s.metrics.every((m) => m.state === 'unknown')).toBe(true);
  });

  it('renders unknown metrics when the workGraph block is missing', () => {
    const s = intelligenceSummaryFromHealth({ data: { sync: {} } }, NOW);
    // Still available (parseable object) but each metric is unknown.
    expect(s.available).toBe(true);
    const docs = s.metrics.find((m) => m.key === 'docVectors');
    expect(docs?.value).toBe('—');
    expect(docs?.state).toBe('unknown');
  });

  it('accepts a bare (non-enveloped) health object', () => {
    const s = intelligenceSummaryFromHealth(LIVE_HEALTH.data, NOW);
    expect(s.available).toBe(true);
    expect(s.metrics.find((m) => m.key === 'impressions')?.value).toBe('1,442');
  });
});

describe('formatRelativeMs', () => {
  const base = Date.parse('2026-07-13T10:00:00.000Z');
  it('formats minutes, hours, days, and just-now', () => {
    expect(formatRelativeMs('2026-07-13T09:59:40.000Z', base)).toBe('just now');
    expect(formatRelativeMs('2026-07-13T09:40:00.000Z', base)).toBe('20m ago');
    expect(formatRelativeMs('2026-07-13T07:00:00.000Z', base)).toBe('3h ago');
    expect(formatRelativeMs('2026-07-11T10:00:00.000Z', base)).toBe('2d ago');
  });
  it('passes through an unparseable timestamp', () => {
    expect(formatRelativeMs('not-a-date', base)).toBe('not-a-date');
  });
});
