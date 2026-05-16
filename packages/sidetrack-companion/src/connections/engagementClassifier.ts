import { createHash } from 'node:crypto';

import type { EngagementDimensions } from '../engagement/events.js';

export const ENGAGEMENT_CLASS_PRODUCER_KEY = 'engagement-class:v1:rules' as const;

export const ENGAGEMENT_CLASSES = [
  'parked_background',
  'glanced',
  'skimmed',
  'engaged_read',
  'worked_on_reference',
  'source_extracted',
  'execution_source',
] as const;

export type EngagementClass = (typeof ENGAGEMENT_CLASSES)[number];

export interface EngagementClassifierInput {
  readonly visitId: string;
  readonly canonicalUrl: string;
  readonly engagement: EngagementDimensions;
  readonly hasDownstreamPasteLineage: boolean;
  readonly distinctPasteDestinationKinds: number;
}

export type EngagementRuleField =
  | 'engagement.activeMs'
  | 'engagement.focusedWindowMs'
  | 'engagement.maxScrollRatio'
  | 'engagement.copyCount'
  | 'engagement.returnCount'
  | 'engagement.scrollEvents'
  | 'hasDownstreamPasteLineage'
  | 'distinctPasteDestinationKinds';

export type EngagementRuleOperator = 'eq' | 'lt' | 'gte';

export interface EngagementRuleCondition {
  readonly field: EngagementRuleField;
  readonly op: EngagementRuleOperator;
  readonly value: number | boolean;
}

export interface EngagementRuleDefinition {
  readonly class: EngagementClass;
  readonly conditions: readonly EngagementRuleCondition[];
}

export interface EngagementRuleThresholds {
  readonly parkedBackground: {
    readonly focusedWindowMsLt: number;
    readonly activeMsLt: number;
  };
  readonly glanced: {
    readonly activeMsLt: number;
    readonly maxScrollRatioLt: number;
    readonly copyCountEq: number;
  };
  readonly skimmed: {
    readonly activeMsGte: number;
    readonly activeMsLt: number;
    readonly maxScrollRatioGte: number;
    readonly copyCountEq: number;
    readonly scrollEventsGte: number;
  };
  readonly engagedRead: {
    readonly activeMsGte: number;
    readonly maxScrollRatioGte: number;
    readonly returnCountGte: number;
  };
  readonly workedOnReference: {
    readonly activeMsGte: number;
    readonly copyCountGte: number;
    readonly returnCountGte: number;
  };
  readonly sourceExtracted: {
    readonly copyCountGte: number;
    readonly hasDownstreamPasteLineage: true;
  };
  readonly executionSource: {
    readonly copyCountGte: number;
    readonly distinctPasteDestinationKindsGte: number;
  };
}

export const DEFAULT_ENGAGEMENT_RULE_THRESHOLDS: EngagementRuleThresholds = {
  parkedBackground: {
    focusedWindowMsLt: 2_000,
    activeMsLt: 1_000,
  },
  glanced: {
    activeMsLt: 5_000,
    maxScrollRatioLt: 0.15,
    copyCountEq: 0,
  },
  skimmed: {
    activeMsGte: 5_000,
    activeMsLt: 30_000,
    maxScrollRatioGte: 0.15,
    copyCountEq: 0,
    scrollEventsGte: 3,
  },
  engagedRead: {
    activeMsGte: 30_000,
    maxScrollRatioGte: 0.4,
    returnCountGte: 1,
  },
  workedOnReference: {
    activeMsGte: 30_000,
    copyCountGte: 1,
    returnCountGte: 2,
  },
  sourceExtracted: {
    copyCountGte: 1,
    hasDownstreamPasteLineage: true,
  },
  executionSource: {
    copyCountGte: 2,
    distinctPasteDestinationKindsGte: 2,
  },
};

export const buildEngagementRuleTable = (
  thresholds: EngagementRuleThresholds = DEFAULT_ENGAGEMENT_RULE_THRESHOLDS,
): readonly EngagementRuleDefinition[] => [
  {
    class: 'parked_background',
    conditions: [
      {
        field: 'engagement.focusedWindowMs',
        op: 'lt',
        value: thresholds.parkedBackground.focusedWindowMsLt,
      },
      {
        field: 'engagement.activeMs',
        op: 'lt',
        value: thresholds.parkedBackground.activeMsLt,
      },
    ],
  },
  {
    class: 'glanced',
    conditions: [
      { field: 'engagement.activeMs', op: 'lt', value: thresholds.glanced.activeMsLt },
      {
        field: 'engagement.maxScrollRatio',
        op: 'lt',
        value: thresholds.glanced.maxScrollRatioLt,
      },
      { field: 'engagement.copyCount', op: 'eq', value: thresholds.glanced.copyCountEq },
    ],
  },
  {
    class: 'skimmed',
    conditions: [
      { field: 'engagement.activeMs', op: 'gte', value: thresholds.skimmed.activeMsGte },
      { field: 'engagement.activeMs', op: 'lt', value: thresholds.skimmed.activeMsLt },
      {
        field: 'engagement.maxScrollRatio',
        op: 'gte',
        value: thresholds.skimmed.maxScrollRatioGte,
      },
      { field: 'engagement.copyCount', op: 'eq', value: thresholds.skimmed.copyCountEq },
      { field: 'engagement.scrollEvents', op: 'gte', value: thresholds.skimmed.scrollEventsGte },
    ],
  },
  {
    class: 'engaged_read',
    conditions: [
      { field: 'engagement.activeMs', op: 'gte', value: thresholds.engagedRead.activeMsGte },
      {
        field: 'engagement.maxScrollRatio',
        op: 'gte',
        value: thresholds.engagedRead.maxScrollRatioGte,
      },
      {
        field: 'engagement.returnCount',
        op: 'gte',
        value: thresholds.engagedRead.returnCountGte,
      },
    ],
  },
  {
    class: 'worked_on_reference',
    conditions: [
      {
        field: 'engagement.activeMs',
        op: 'gte',
        value: thresholds.workedOnReference.activeMsGte,
      },
      {
        field: 'engagement.copyCount',
        op: 'gte',
        value: thresholds.workedOnReference.copyCountGte,
      },
      {
        field: 'engagement.returnCount',
        op: 'gte',
        value: thresholds.workedOnReference.returnCountGte,
      },
    ],
  },
  {
    class: 'source_extracted',
    conditions: [
      {
        field: 'engagement.copyCount',
        op: 'gte',
        value: thresholds.sourceExtracted.copyCountGte,
      },
      {
        field: 'hasDownstreamPasteLineage',
        op: 'eq',
        value: thresholds.sourceExtracted.hasDownstreamPasteLineage,
      },
    ],
  },
  {
    class: 'execution_source',
    conditions: [
      {
        field: 'engagement.copyCount',
        op: 'gte',
        value: thresholds.executionSource.copyCountGte,
      },
      {
        field: 'distinctPasteDestinationKinds',
        op: 'gte',
        value: thresholds.executionSource.distinctPasteDestinationKindsGte,
      },
    ],
  },
];

export const DEFAULT_ENGAGEMENT_RULE_TABLE = buildEngagementRuleTable();

export interface EngagementClassRevision {
  readonly revisionId: string;
  readonly producerKey: typeof ENGAGEMENT_CLASS_PRODUCER_KEY;
  readonly ruleTableHash: string;
  readonly classifications: readonly {
    readonly visitId: string;
    readonly canonicalUrl: string;
    readonly class: EngagementClass;
    // Subset of the engagement dimensions that drove the class. Plumbed
    // through so the connections snapshot — and ultimately the Flow Path
    // visit cell — can show "1m 30s focused · 24 scrolls" without
    // every consumer carrying the full event stream.
    readonly focusedWindowMs: number;
    readonly scrollEvents: number;
  }[];
  readonly producedAt: number;
}

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
};

const sortedRuleTable = (
  ruleTable: readonly EngagementRuleDefinition[],
): readonly EngagementRuleDefinition[] =>
  [...ruleTable]
    .map((rule) => ({
      class: rule.class,
      conditions: [...rule.conditions].sort((a, b) => {
        if (a.field !== b.field) return a.field < b.field ? -1 : 1;
        if (a.op !== b.op) return a.op < b.op ? -1 : 1;
        const left = String(a.value);
        const right = String(b.value);
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    }))
    .sort((a, b) => (a.class < b.class ? -1 : a.class > b.class ? 1 : 0));

export const engagementRuleTableHash = (
  ruleTable: readonly EngagementRuleDefinition[] = DEFAULT_ENGAGEMENT_RULE_TABLE,
): string => sha256Hex(JSON.stringify(canonicalize(sortedRuleTable(ruleTable))));

export const engagementRevisionIdForRuleTable = (
  ruleTable: readonly EngagementRuleDefinition[] = DEFAULT_ENGAGEMENT_RULE_TABLE,
): string =>
  sha256Hex(`${ENGAGEMENT_CLASS_PRODUCER_KEY}${engagementRuleTableHash(ruleTable)}`).slice(0, 16);

const isParkedBackground = (
  input: EngagementClassifierInput,
  thresholds: EngagementRuleThresholds,
): boolean =>
  input.engagement.focusedWindowMs < thresholds.parkedBackground.focusedWindowMsLt &&
  input.engagement.activeMs < thresholds.parkedBackground.activeMsLt;

const isSourceExtracted = (
  input: EngagementClassifierInput,
  thresholds: EngagementRuleThresholds,
): boolean =>
  input.engagement.copyCount >= thresholds.sourceExtracted.copyCountGte &&
  input.hasDownstreamPasteLineage === thresholds.sourceExtracted.hasDownstreamPasteLineage;

export const classifyEngagement = (
  input: EngagementClassifierInput,
  thresholds: EngagementRuleThresholds = DEFAULT_ENGAGEMENT_RULE_THRESHOLDS,
): EngagementClass => {
  const sourceExtracted = isSourceExtracted(input, thresholds);
  if (
    sourceExtracted &&
    input.engagement.copyCount >= thresholds.executionSource.copyCountGte &&
    input.distinctPasteDestinationKinds >=
      thresholds.executionSource.distinctPasteDestinationKindsGte
  ) {
    return 'execution_source';
  }

  if (sourceExtracted) return 'source_extracted';

  if (
    input.engagement.activeMs >= thresholds.workedOnReference.activeMsGte &&
    input.engagement.copyCount >= thresholds.workedOnReference.copyCountGte &&
    input.engagement.returnCount >= thresholds.workedOnReference.returnCountGte
  ) {
    return 'worked_on_reference';
  }

  if (
    input.engagement.activeMs >= thresholds.engagedRead.activeMsGte &&
    input.engagement.maxScrollRatio >= thresholds.engagedRead.maxScrollRatioGte &&
    input.engagement.returnCount >= thresholds.engagedRead.returnCountGte
  ) {
    return 'engaged_read';
  }

  if (
    input.engagement.activeMs >= thresholds.skimmed.activeMsGte &&
    input.engagement.activeMs < thresholds.skimmed.activeMsLt &&
    input.engagement.maxScrollRatio >= thresholds.skimmed.maxScrollRatioGte &&
    input.engagement.copyCount === thresholds.skimmed.copyCountEq &&
    input.engagement.scrollEvents >= thresholds.skimmed.scrollEventsGte
  ) {
    return 'skimmed';
  }

  if (
    !isParkedBackground(input, thresholds) &&
    input.engagement.activeMs < thresholds.glanced.activeMsLt &&
    input.engagement.maxScrollRatio < thresholds.glanced.maxScrollRatioLt &&
    input.engagement.copyCount === thresholds.glanced.copyCountEq
  ) {
    return 'glanced';
  }

  return 'parked_background';
};

export const buildEngagementClassRevision = (
  inputs: readonly EngagementClassifierInput[],
  options: {
    readonly thresholds?: EngagementRuleThresholds;
    readonly producedAt?: number;
  } = {},
): EngagementClassRevision => {
  const thresholds = options.thresholds ?? DEFAULT_ENGAGEMENT_RULE_THRESHOLDS;
  const ruleTable = buildEngagementRuleTable(thresholds);
  const classifications = [...inputs]
    .sort((a, b) =>
      a.visitId === b.visitId
        ? a.canonicalUrl.localeCompare(b.canonicalUrl)
        : a.visitId.localeCompare(b.visitId),
    )
    .map((input) => ({
      visitId: input.visitId,
      canonicalUrl: input.canonicalUrl,
      class: classifyEngagement(input, thresholds),
      focusedWindowMs: input.engagement.focusedWindowMs,
      scrollEvents: input.engagement.scrollEvents,
    }));

  return {
    revisionId: engagementRevisionIdForRuleTable(ruleTable),
    producerKey: ENGAGEMENT_CLASS_PRODUCER_KEY,
    ruleTableHash: engagementRuleTableHash(ruleTable),
    classifications,
    producedAt: options.producedAt ?? 0,
  };
};
