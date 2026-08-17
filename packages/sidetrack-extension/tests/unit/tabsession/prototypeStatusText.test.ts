import { describe, expect, it } from 'vitest';

import type { WorkstreamPrototypeStatus } from '../../../src/companion/categoryFlexibilityClient';
import { prototypeStatusLine } from '../../../src/sidepanel/tabsession/prototypeStatusText';

const status = (over: Partial<WorkstreamPrototypeStatus> = {}): WorkstreamPrototypeStatus => ({
  workstreamId: 'ws-1',
  prototypeCount: 0,
  generatedAt: null,
  evidenceCount: 0,
  evidenceWatermark: null,
  engine: null,
  engineLabel: null,
  method: null,
  methodNote: null,
  whyNot: null,
  whyNotDetail: null,
  ...over,
});

describe('prototypeStatusLine', () => {
  it('renders the honest why-not verbatim when no prototypes exist', () => {
    expect(prototypeStatusLine(status({ whyNot: 'needs 5+ saved pages, has 2' }))).toBe(
      'needs 5+ saved pages, has 2',
    );
  });

  it('renders count · updated · evidence-count for a generated batch', () => {
    const now = Date.parse('2026-08-17T12:00:00.000Z');
    const generatedAt = now - 2 * 60 * 60 * 1000; // 2h ago
    const line = prototypeStatusLine(
      status({ prototypeCount: 3, generatedAt, evidenceCount: 12 }),
      now,
    );
    expect(line).toBe('3 prototypes · updated 2h ago from 12 pages');
  });

  it('singularizes prototype/page counts of exactly 1', () => {
    const now = Date.parse('2026-08-17T12:00:00.000Z');
    const generatedAt = now - 60 * 60 * 1000;
    const line = prototypeStatusLine(
      status({ prototypeCount: 1, generatedAt, evidenceCount: 1 }),
      now,
    );
    expect(line).toBe('1 prototype · updated 1h ago from 1 page');
  });
});
