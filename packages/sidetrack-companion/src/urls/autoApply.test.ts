import { describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot } from '../connections/types.js';
import type { EventLog } from '../sync/eventLog.js';
import { autoApplyUrlAttribution } from './autoApply.js';
import { URL_PROJECTION_SCHEMA_VERSION, type SerializedUrlProjection } from './projection.js';

const canonicalUrl = 'https://example.test/research';

const urlProjection = (): SerializedUrlProjection => ({
  schemaVersion: URL_PROJECTION_SCHEMA_VERSION,
  byCanonicalUrl: {
    [canonicalUrl]: {
      canonicalUrl,
      firstSeenAt: '2026-05-23T20:00:00.000Z',
      lastSeenAt: '2026-05-23T20:05:00.000Z',
      latestUrl: canonicalUrl,
      latestTitle: 'Research',
      provider: 'generic',
      host: 'example.test',
      visitCount: 2,
      tabSessionIds: ['tses_test'],
      attributionHistory: [],
    },
  },
});

const snapshot = (): ConnectionsSnapshot => ({
  scope: {},
  nodes: [],
  edges: [],
  updatedAt: '2026-05-23T20:05:00.000Z',
  nodeCount: 0,
  edgeCount: 0,
  snapshotRevision: 'rev-auto-apply-test',
  urlProjection: urlProjection(),
});

describe('autoApplyUrlAttribution', () => {
  it('uses supplied projection and events without rereading the full event log', async () => {
    const previous = process.env['SIDETRACK_URL_RESOLVER_AUTO_APPLY'];
    process.env['SIDETRACK_URL_RESOLVER_AUTO_APPLY'] = '0';
    const eventLog = {
      readMerged: async () => {
        throw new Error('readMerged should not be called');
      },
      appendServerObserved: async () => {
        throw new Error('appendServerObserved should not be called when disabled');
      },
    } as unknown as EventLog;

    try {
      const result = await autoApplyUrlAttribution({
        eventLog,
        snapshot: snapshot(),
        canonicalUrl,
        events: [],
        urlProjection: urlProjection(),
        useEventCandidateSimilarity: false,
      });

      expect(result.status).toBe('skipped-disabled');
      expect(result.projection.byCanonicalUrl.get(canonicalUrl)?.latestTitle).toBe('Research');
    } finally {
      if (previous === undefined) delete process.env['SIDETRACK_URL_RESOLVER_AUTO_APPLY'];
      else process.env['SIDETRACK_URL_RESOLVER_AUTO_APPLY'] = previous;
    }
  });
});
