import { describe, expect, it } from 'vitest';

import { reliabilitySummaryFromReport } from './reliabilitySummary';

// Mirrors the live-rig GET /v1/system/reliability shape (data envelope).
// Two surfaces with hand-set Platt ECEs: search 0.05 (good), dejavu 0.22
// (worst). The metric must report the WORST (max) ECE = 0.22 for dejavu.
const LIVE_RELIABILITY = {
  data: {
    availability: 'ok',
    generatedAt: '2026-07-13T12:00:00.000Z',
    report: {
      generatedAt: '2026-07-13T12:00:00.000Z',
      numBins: 10,
      totalSamples: 40,
      surfaces: [
        {
          surface: 'search',
          fit: {
            sampleCount: 20,
            positiveCount: 8,
            plattReliability: { ece: 0.05, mce: 0.1 },
          },
        },
        {
          surface: 'dejavu',
          fit: {
            sampleCount: 20,
            positiveCount: 4,
            plattReliability: { ece: 0.22, mce: 0.4 },
          },
        },
      ],
    },
  },
};

describe('reliabilitySummaryFromReport', () => {
  it('reports the worst-surface Platt ECE with the surface name as detail', () => {
    const metric = reliabilitySummaryFromReport(LIVE_RELIABILITY);
    expect(metric.key).toBe('calibration');
    expect(metric.value).toBe('ECE 0.220');
    expect(metric.detail).toBe('worst: dejavu');
    // 0.22 > 0.1 → not "well-calibrated" → idle dot, not live.
    expect(metric.state).toBe('idle');
  });

  it('marks a well-calibrated report (all ECE ≤ 0.1) as live', () => {
    const good = {
      data: {
        report: {
          surfaces: [{ surface: 'search', fit: { plattReliability: { ece: 0.04 } } }],
        },
      },
    };
    const metric = reliabilitySummaryFromReport(good);
    expect(metric.value).toBe('ECE 0.040');
    expect(metric.state).toBe('live');
  });

  it('renders "no signal" when there are no gradeable surfaces yet', () => {
    const empty = { data: { report: { surfaces: [] } } };
    const metric = reliabilitySummaryFromReport(empty);
    expect(metric.value).toBe('no signal');
    expect(metric.state).toBe('idle');
  });

  it('renders "—" when the payload is not a reliability report (older companion)', () => {
    expect(reliabilitySummaryFromReport(undefined).value).toBe('—');
    expect(reliabilitySummaryFromReport({}).value).toBe('—');
    expect(reliabilitySummaryFromReport({ data: {} }).value).toBe('—');
  });

  it('accepts a bare (non-enveloped) report too', () => {
    const bare = {
      report: { surfaces: [{ surface: 'focus', fit: { plattReliability: { ece: 0.15 } } }] },
    };
    const metric = reliabilitySummaryFromReport(bare);
    expect(metric.value).toBe('ECE 0.150');
    expect(metric.detail).toBe('worst: focus');
  });

  it('skips surfaces with no readable ECE and returns "—" when none have one', () => {
    const noEce = {
      data: { report: { surfaces: [{ surface: 'search', fit: { plattReliability: {} } }] } },
    };
    expect(reliabilitySummaryFromReport(noEce).value).toBe('—');
  });
});
