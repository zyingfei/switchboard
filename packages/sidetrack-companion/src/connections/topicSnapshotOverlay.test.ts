import { describe, expect, it } from 'vitest';

import {
  TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
  type TopicRevision,
} from '../producers/topic-revision.js';
import { overlayTopicRevisionOnSnapshot } from './topicSnapshotOverlay.js';
import { nodeIdFor, type ConnectionsSnapshot } from './types.js';

describe('overlayTopicRevisionOnSnapshot', () => {
  it('preserves secondary topic affiliations in the shadow snapshot overlay', () => {
    const baseSnapshot: ConnectionsSnapshot = {
      scope: {},
      nodes: [],
      edges: [],
      updatedAt: '2026-05-14T10:00:00.000Z',
      nodeCount: 0,
      edgeCount: 0,
    };
    const topicRevision: TopicRevision = {
      revisionId: 'shadow-rev-1',
      visitSimilarityRevisionId: 'sim-rev-1',
      cosineThreshold: 0.85,
      algorithmVersion: TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
      producedAt: Date.parse('2026-05-14T10:00:00.000Z'),
      topics: [
        {
          topicId: 'topic:oracle',
          memberCanonicalUrls: ['https://db.example/oracle'],
          metadata: {
            memberCount: 1,
            representativeTitles: ['Oracle 26ai'],
            firstObservedAt: '2026-05-14T09:00:00.000Z',
            lastObservedAt: '2026-05-14T10:00:00.000Z',
            cohesion: 0.91,
          },
          secondaryAffiliations: [
            {
              canonicalUrl: 'https://ai.example/decision-framework',
              score: 0.78,
              reasons: ['edge_support', 'member_similarity', 'reciprocal_support'],
              supportCount: 2,
              maxCosine: 0.89,
              lexicalScore: 0.22,
              reciprocalSupport: 1,
            },
          ],
        },
      ],
      lineage: [],
    };

    const overlaid = overlayTopicRevisionOnSnapshot(baseSnapshot, topicRevision);
    const membershipEdges = overlaid.edges.filter((edge) => edge.kind === 'visit_in_topic');

    expect(membershipEdges).toHaveLength(2);
    expect(
      membershipEdges.find(
        (edge) => edge.fromNodeId === nodeIdFor('timeline-visit', 'https://db.example/oracle'),
      )?.metadata,
    ).toMatchObject({ affiliation: 'primary' });
    expect(
      membershipEdges.find(
        (edge) =>
          edge.fromNodeId === nodeIdFor('timeline-visit', 'https://ai.example/decision-framework'),
      )?.metadata,
    ).toMatchObject({
      affiliation: 'secondary',
      score: 0.78,
      reasons: ['edge_support', 'member_similarity', 'reciprocal_support'],
      supportCount: 2,
      maxCosine: 0.89,
      lexicalScore: 0.22,
      reciprocalSupport: 1,
    });
  });
});
