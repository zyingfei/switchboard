import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { EngagementDimensions } from '../engagement/events.js';
import {
  buildEngagementClassRevision,
  buildEngagementRuleTable,
  classifyEngagement,
  DEFAULT_ENGAGEMENT_RULE_THRESHOLDS,
  ENGAGEMENT_CLASSES,
  engagementRevisionIdForRuleTable,
  type EngagementClass,
  type EngagementClassifierInput,
} from './engagementClassifier.js';

const engagement = (overrides: Partial<EngagementDimensions> = {}): EngagementDimensions => ({
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isEngagementClass = (value: unknown): value is EngagementClass =>
  typeof value === 'string' && ENGAGEMENT_CLASSES.includes(value as EngagementClass);

type MutableEngagementOverrides = {
  -readonly [Key in keyof EngagementDimensions]?: EngagementDimensions[Key];
};

const parseEngagementOverrides = (value: unknown): MutableEngagementOverrides => {
  if (!isRecord(value)) return {};
  const overrides: MutableEngagementOverrides = {};
  const fields: readonly (keyof EngagementDimensions)[] = [
    'activeMs',
    'visibleMs',
    'focusedWindowMs',
    'idleMs',
    'foregroundBursts',
    'returnCount',
    'scrollEvents',
    'maxScrollRatio',
    'copyCount',
    'pasteCount',
  ];
  for (const field of fields) {
    const fieldValue = value[field];
    if (isFiniteNumber(fieldValue)) {
      overrides[field] = fieldValue;
    }
  }
  return overrides;
};

interface EngagementFixtureCase {
  readonly name: string;
  readonly classifierInput: EngagementClassifierInput;
  readonly expectedClass?: EngagementClass;
  readonly notClass?: EngagementClass;
}

const readEngagementFixtureCases = async (): Promise<readonly EngagementFixtureCase[]> => {
  const raw = await readFile(
    new URL('./__fixtures__/engagement-7-classes.json', import.meta.url),
    'utf8',
  );
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed['cases'])) {
    throw new Error('invalid engagement fixture');
  }

  return parsed['cases'].map((caseValue): EngagementFixtureCase => {
    if (
      !isRecord(caseValue) ||
      typeof caseValue['name'] !== 'string' ||
      !isRecord(caseValue['input'])
    ) {
      throw new Error('invalid engagement fixture case');
    }
    const expectedClass = caseValue['expectedClass'];
    const notClass = caseValue['notClass'];
    if (expectedClass !== undefined && !isEngagementClass(expectedClass)) {
      throw new Error(`invalid expected class in ${caseValue['name']}`);
    }
    if (notClass !== undefined && !isEngagementClass(notClass)) {
      throw new Error(`invalid negative class in ${caseValue['name']}`);
    }
    const downstream = caseValue['input']['hasDownstreamPasteLineage'];
    const destinationKinds = caseValue['input']['distinctPasteDestinationKinds'];
    return {
      name: caseValue['name'],
      classifierInput: input({
        engagement: parseEngagementOverrides(caseValue['input']['engagement']),
        ...(typeof downstream === 'boolean' ? { hasDownstreamPasteLineage: downstream } : {}),
        ...(isFiniteNumber(destinationKinds)
          ? { distinctPasteDestinationKinds: destinationKinds }
          : {}),
      }),
      ...(expectedClass === undefined ? {} : { expectedClass }),
      ...(notClass === undefined ? {} : { notClass }),
    };
  });
};

describe('engagement classifier rules', () => {
  it('matches the documented 7-class fixture cases', async () => {
    const cases = await readEngagementFixtureCases();

    expect(cases).toHaveLength(14);
    for (const caseValue of cases) {
      const result = classifyEngagement(caseValue.classifierInput);
      if (caseValue.expectedClass !== undefined) {
        expect(result, caseValue.name).toBe(caseValue.expectedClass);
      }
      if (caseValue.notClass !== undefined) {
        expect(result, caseValue.name).not.toBe(caseValue.notClass);
      }
    }
  });

  it('classifies parked_background at the focused and active boundary', () => {
    expect(
      classifyEngagement(input({ engagement: { focusedWindowMs: 1_500, activeMs: 500 } })),
    ).toBe('parked_background');
    expect(
      classifyEngagement(input({ engagement: { focusedWindowMs: 2_500, activeMs: 1_500 } })),
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
    expect(classifyEngagement(input({ engagement: { ...skimmed, copyCount: 1 } }))).not.toBe(
      'skimmed',
    );
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

  it('determinism: repeated classification and revision builds', () => {
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
    expect(engagementRevisionIdForRuleTable(changedRuleTable)).not.toBe(baseRevision.revisionId);
  });
});
