import { describe, expect, it } from 'vitest';

import { createRecallActivityTracker } from './activity.js';

describe('RecallActivityTracker', () => {
  it('recordIngestFailed pushes an "ingest-failed" event with the supplied error onto recent', () => {
    let tick = 0;
    const tracker = createRecallActivityTracker(() => new Date(1_780_000_000_000 + tick++));
    tracker.recordIngestFailed('RECALL_MODEL_MISSING: cache empty');
    const report = tracker.report();
    expect(report.recent[0]).toMatchObject({
      kind: 'ingest-failed',
      error: 'RECALL_MODEL_MISSING: cache empty',
    });
    // Failed-ingest does NOT advance the lastIndexed* fields — those
    // track successful projections only. Without this invariant a
    // stalled offline ingestor would look like a recent successful
    // index in /v1/system/health.
    expect(report.lastIndexedAt).toBeNull();
    expect(report.lastIndexedCount).toBeNull();
  });

  it('a successful incremental-index after a failed ingest is reflected normally', () => {
    let tick = 0;
    const tracker = createRecallActivityTracker(() => new Date(1_780_000_000_000 + tick++));
    tracker.recordIngestFailed('RECALL_MODEL_MISSING: cache empty');
    tracker.recordIncrementalIndex({ count: 3, threadIds: ['t1', 't2'] });
    const report = tracker.report();
    expect(report.lastIndexedCount).toBe(3);
    expect(report.recent[0]?.kind).toBe('incremental-index');
    expect(report.recent[1]?.kind).toBe('ingest-failed');
  });
});
