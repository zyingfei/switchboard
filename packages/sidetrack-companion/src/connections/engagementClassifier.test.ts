import { describe, expect, it } from 'vitest';

import type { EngagementDimensions } from '../engagement/events.js';
import {
  buildEngagementClassRevision,
  buildEngagementRuleTable,
  classifyEngagement,
  DEFAULT_ENGAGEMENT_RULE_THRESHOLDS,
  engagementRevisionIdForRuleTable,
  type EngagementClassifierInput,
} from './engagementClassifier.js';

const engagement = (
  overrides: Partial<EngagementDimensions> = {},
): EngagementDimensions => ({
  activeMs: 0,
  visibleMs: 0,
  focusedWindowMs: 10_000,
  idleMs: 0,
  foregroundBursts: 1,
  returnCount: 0,
  scrollEvents: 0,
  maxScrollRatio: 0,
  copyCount: 0,
  pasteCount: 0,
  ...overrides,
});

const input = (
  overrides: {
    readonly engagement?: Partial<EngagementDimensions>;
    readonly hasDownstreamPasteLineage?: boolean;
    readonly distinctPasteDestinationKinds?: number;
  } = {},
): EngagementClassifierInput => ({
  visitId: 'visit:https://example.test/reference',
  canonicalUrl: 'https://example.test/reference',
  engagement: engagement(overrides.engagement),
  hasDownstreamPasteLineage: overrides.hasDownstreamPasteLineage ?? false,
  distinctPasteDestinationKinds: overrides.distinctPasteDestinationKinds ?? 0,
});

describe('engagement classifier rules', () => {
  it('classifies parked_background at the focused and active boundary', () => {
    expect(
      classifyEngagement(
        input({ engagement: { focusedWindowMs: 1_500, activeMs: 500 } }),
      ),
    ).toBe('parked_background');
    expect(
      classifyEngagement(
        input({ engagement: { focusedWindowMs: 2_500, activeMs: 1_500 } }),
      ),
    ).not.toBe('parked_background');
  });

  it('classifies glanced below the active and scroll thresholds', () => {
    expect(
      classifyEngagement(
        input({ engagement: { activeMs: 4_500, maxScrollRatio: 0.1, copyCount: 0 } }),
      ),
    ).toBe('glanced');
    expect(
      classifyEngagement(
        input({ engagement: { activeMs: 5_500, maxScrollRatio: 0.1, copyCount: 0 } }),
      ),
    ).not.toBe('glanced');
  });

  it('classifies skimmed only when copyCount stays zero', () => {
    const skimmed = {
      activeMs: 10_000,
      maxScrollRatio: 0.3,
      scrollEvents: 5,
      copyCount: 0,
    };
    expect(classifyEngagement(input({ engagement: skimmed }))).toBe('skimmed');
    expect(
      classifyEngagement(input({ engagement: { ...skimmed, copyCount: 1 } })),
    ).not.toBe('skimmed');
  });

  it('classifies engaged_read even without copies', () => {
    expect(
      classifyEngagement(
        input({
          engagement: {
            activeMs: 35_000,
            maxScrollRatio: 0.5,
            returnCount: 2,
            copyCount: 0,
          },
        }),
      ),
    ).toBe('engaged_read');
  });

  it('classifies worked_on_reference before engaged_read when copy and return thresholds pass', () => {
    expect(
      classifyEngagement(
        input({
          engagement: {
            activeMs: 35_000,
            maxScrollRatio: 0.5,
            copyCount: 2,
            returnCount: 2,
          },
        }),
      ),
    ).toBe('worked_on_reference');
  });

  it('classifies source_extracted from downstream paste lineage', () => {
    expect(
      classifyEngagement(
        input({
          engagement: {
            activeMs: 35_000,
            maxScrollRatio: 0.5,
            copyCount: 2,
            returnCount: 2,
          },
          hasDownstreamPasteLineage: true,
        }),
      ),
    ).toBe('source_extracted');
  });

  it('classifies execution_source when a copied source fans out to multiple destination kinds', () => {
    expect(
      classifyEngagement(
        input({
          engagement: {
            activeMs: 35_000,
            maxScrollRatio: 0.5,
            copyCount: 3,
            returnCount: 2,
          },
          hasDownstreamPasteLineage: true,
          distinctPasteDestinationKinds: 2,
        }),
      ),
    ).toBe('execution_source');
  });

  it('is deterministic for repeated classification and revision builds', () => {
    const row = input({
      engagement: {
        activeMs: 35_000,
        maxScrollRatio: 0.5,
        copyCount: 3,
        returnCount: 2,
      },
      hasDownstreamPasteLineage: true,
      distinctPasteDestinationKinds: 2,
    });
    const classes = Array.from({ length: 100 }, () => classifyEngagement(row));
    expect(new Set(classes)).toEqual(new Set(['execution_source']));

    const first = buildEngagementClassRevision([row], { producedAt: 1 });
    const second = buildEngagementClassRevision([row], { producedAt: 1 });
    expect(first).toEqual(second);
  });

  it('keeps revision ids stable until the rule table changes', () => {
    const baseRevision = buildEngagementClassRevision([input()], { producedAt: 1 });
    const sameRevision = buildEngagementClassRevision([input()], { producedAt: 2 });
    expect(sameRevision.revisionId).toBe(baseRevision.revisionId);

    const changedRuleTable = buildEngagementRuleTable({
      ...DEFAULT_ENGAGEMENT_RULE_THRESHOLDS,
      glanced: {
        ...DEFAULT_ENGAGEMENT_RULE_THRESHOLDS.glanced,
        activeMsLt: 6_000,
      },
    });
    expect(engagementRevisionIdForRuleTable(changedRuleTable)).not.toBe(
      baseRevision.revisionId,
    );
  });
});
