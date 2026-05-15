import { describe, expect, it } from 'vitest';

import {
  TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
  TOPIC_UNION_FIND_REVISION_KEY,
  type TopicAlgorithmVersion,
  type TopicRevision,
} from '../producers/topic-revision.js';
import { buildTopicShadowObservationDiagnostics } from './topicShadowObservation.js';

const revision = (
  revisionId: string,
  topics: readonly { readonly topicId: string; readonly members: readonly string[] }[],
  algorithmVersion: TopicAlgorithmVersion = TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
): TopicRevision => ({
  revisionId,
  visitSimilarityRevisionId: 'sim-rev',
  cosineThreshold: 0.85,
  algorithmVersion,
  topics: topics.map((topic) => ({
    topicId: topic.topicId,
    memberCanonicalUrls: topic.members,
    metadata: {
      memberCount: topic.members.length,
      representativeTitles: [topic.topicId],
      firstObservedAt: '2026-05-14T10:00:00.000Z',
      lastObservedAt: '2026-05-14T10:00:00.000Z',
      cohesion: 0.9,
    },
  })),
  lineage: [],
  producedAt: Date.parse('2026-05-14T10:00:00.000Z'),
});

describe('buildTopicShadowObservationDiagnostics', () => {
  it('measures adjacent shadow churn through best-overlap continuity', () => {
    const previousShadow = revision('shadow-prev', [
      { topicId: 'topic:old-a', members: ['a', 'b', 'c', 'd'] },
      { topicId: 'topic:old-b', members: ['x', 'y'] },
    ]);
    const shadow = revision('shadow-next', [
      { topicId: 'topic:new-a', members: ['a', 'b'] },
      { topicId: 'topic:new-b', members: ['c'] },
      { topicId: 'topic:new-c', members: ['d', 'x', 'y'] },
    ]);

    const diagnostics = buildTopicShadowObservationDiagnostics({
      baselineRevision: revision(
        'baseline-next',
        [{ topicId: 'topic:collapsed', members: Array.from({ length: 60 }, (_, i) => `v${i}`) }],
        TOPIC_UNION_FIND_REVISION_KEY,
      ),
      previousBaselineRevision: revision(
        'baseline-prev',
        [{ topicId: 'topic:small', members: ['a', 'b', 'c', 'd', 'x', 'y'] }],
        TOPIC_UNION_FIND_REVISION_KEY,
      ),
      shadowRevision: shadow,
      previousShadowRevision: previousShadow,
    });

    expect(diagnostics).toMatchObject({
      shadowRevisionId: 'shadow-next',
      previousShadowRevisionId: 'shadow-prev',
      adjacentOverlapVisitCount: 6,
      adjacentChangedVisitCount: 1,
      adjacentPerVisitChurn: 0.166667,
      adjacentRawTopicIdChurn: 1,
      previousShadowTopicCount: 2,
      previousShadowMaxTopicSize: 4,
      previousShadowAssignedVisitCount: 6,
      topicCountDeltaFromPrevious: 1,
      maxTopicSizeDeltaFromPrevious: -1,
      assignedVisitCountDeltaFromPrevious: 0,
      shadowNoiseShare: 0.9,
      previousShadowNoiseShare: 0,
      noiseShareDeltaFromPrevious: 0.9,
      baselineCollapsed: true,
      previousBaselineCollapsed: false,
      activeCollapseBoundaryChanged: true,
      shadowCollapsed: false,
      previousShadowCollapsed: false,
      shadowCollapseBoundaryChanged: false,
    });
  });

  it('omits adjacent metrics when there is no previous shadow revision', () => {
    const diagnostics = buildTopicShadowObservationDiagnostics({
      baselineRevision: revision('baseline', [], TOPIC_UNION_FIND_REVISION_KEY),
      previousBaselineRevision: null,
      shadowRevision: revision('shadow', [{ topicId: 'topic:a', members: ['a', 'b'] }]),
      previousShadowRevision: null,
    });

    expect(diagnostics.previousShadowRevisionId).toBeUndefined();
    expect(diagnostics.adjacentOverlapVisitCount).toBe(0);
    expect(diagnostics.adjacentChangedVisitCount).toBe(0);
    expect(diagnostics.adjacentPerVisitChurn).toBeUndefined();
    expect(diagnostics.activeCollapseBoundaryChanged).toBeUndefined();
  });

  it('mirrors the UI sudden-collapse guard for two-topic outputs', () => {
    const previous = revision(
      'baseline-prev',
      [
        { topicId: 'topic:1', members: ['a'] },
        { topicId: 'topic:2', members: ['b'] },
        { topicId: 'topic:3', members: ['c'] },
        { topicId: 'topic:4', members: ['d'] },
        { topicId: 'topic:5', members: ['e'] },
      ],
      TOPIC_UNION_FIND_REVISION_KEY,
    );
    const current = revision(
      'baseline-next',
      [
        { topicId: 'topic:collapsed-a', members: ['a', 'b'] },
        { topicId: 'topic:collapsed-b', members: ['c', 'd'] },
      ],
      TOPIC_UNION_FIND_REVISION_KEY,
    );

    const diagnostics = buildTopicShadowObservationDiagnostics({
      baselineRevision: current,
      previousBaselineRevision: previous,
      shadowRevision: current,
      previousShadowRevision: previous,
    });

    expect(diagnostics.baselineCollapsed).toBe(true);
    expect(diagnostics.activeCollapseBoundaryChanged).toBe(true);
    expect(diagnostics.shadowCollapsed).toBe(true);
    expect(diagnostics.shadowCollapseBoundaryChanged).toBe(true);
  });
});
