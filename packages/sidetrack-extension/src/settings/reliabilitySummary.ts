// Freeze-safe observability — the "Calibration" metric in the Intelligence
// readout (Settings → Diagnostics). It folds the per-surface reliability
// artifact GET /v1/system/reliability (north-star §5 S1) into one compact
// metric: the WORST per-surface ECE (Expected Calibration Error) currently
// observed, so "are the served probabilities honest?" has a one-look
// answer. Worst-surface (max ECE) is the conservative summary — a single
// mis-calibrated surface should not be hidden by well-calibrated ones.
//
// Pure + defensive: an older companion that lacks the endpoint, or a report
// with no gradeable surfaces yet, renders "—" rather than throwing. Mirrors
// intelligenceSummary.ts's guard discipline.

import type { IntelligenceMetric } from './intelligenceSummary';

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const asArray = (value: unknown): readonly unknown[] | undefined =>
  Array.isArray(value) ? value : undefined;

/** The "Calibration" metric key extends the Intelligence readout's set. */
export type ReliabilityMetric = IntelligenceMetric & { readonly key: 'calibration' };

const unknownReliability = (title: string): ReliabilityMetric => ({
  key: 'calibration',
  label: 'Calibration',
  value: '—',
  state: 'unknown',
  title,
});

/**
 * Parse the raw /v1/system/reliability payload into the Calibration metric.
 * The report shape is `{ availability, generatedAt, report: { surfaces:
 * [{ surface, fit: { plattReliability: { ece }, ... } }], totalSamples } }`.
 * We read the PLATT-calibrated ECE per surface (the served-side calibrator)
 * and report the worst (max) as the headline, with the surface count as
 * detail. Unknown shape / no surfaces → "—".
 */
export const reliabilitySummaryFromReport = (raw: unknown): ReliabilityMetric => {
  const envelope = asRecord(raw);
  const data = asRecord(envelope?.['data']) ?? envelope;
  const report = asRecord(data?.['report']);
  const surfaces = asArray(report?.['surfaces']);
  if (surfaces === undefined) {
    return unknownReliability(
      'Per-surface calibration reliability (ECE) from /v1/system/reliability. ' +
        'Unavailable on an older companion.',
    );
  }
  if (surfaces.length === 0) {
    return {
      key: 'calibration',
      label: 'Calibration',
      value: 'no signal',
      state: 'idle',
      title:
        'No gradeable impressions yet — a surface needs served candidates with ' +
        'joined engagement actions before its reliability (ECE) can be measured.',
    };
  }
  let worstEce: number | undefined;
  let worstSurface: string | undefined;
  for (const entry of surfaces) {
    const surfaceRec = asRecord(entry);
    const name = asString(surfaceRec?.['surface']);
    const fit = asRecord(surfaceRec?.['fit']);
    const plattReliability = asRecord(fit?.['plattReliability']);
    const ece = asNumber(plattReliability?.['ece']);
    if (ece === undefined) continue;
    if (worstEce === undefined || ece > worstEce) {
      worstEce = ece;
      worstSurface = name;
    }
  }
  if (worstEce === undefined) {
    return unknownReliability(
      'Reliability report present but no per-surface ECE could be read ' +
        '(older report schema).',
    );
  }
  // ECE ≤ 0.1 is a common "well-calibrated" heuristic; render the dot state
  // accordingly (this is display-only, not a serving gate).
  const state: IntelligenceMetric['state'] = worstEce <= 0.1 ? 'live' : 'idle';
  return {
    key: 'calibration',
    label: 'Calibration',
    value: `ECE ${worstEce.toFixed(3)}`,
    ...(worstSurface === undefined
      ? { detail: `${String(surfaces.length)} surfaces` }
      : { detail: `worst: ${worstSurface}` }),
    state,
    title:
      'Worst per-surface Expected Calibration Error over the joined ' +
      'impression→action stream (GET /v1/system/reliability, Platt-scaled). ' +
      'Measurement only — nothing consumes the calibration yet (north-star §5 S1).',
  };
};
