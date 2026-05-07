import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from './causal.js';
import { createEventLog } from './eventLog.js';
import { createProjectionChangeFeed } from './projectionChanges.js';
import { runImportProjectors } from './projectors.js';
import { loadOrCreateReplica } from './replicaId.js';
import { readReviewDraft } from '../vault/reviewDrafts.js';

describe('runImportProjectors', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-projectors-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('writes the review-draft projection AND appends a change-feed row when a peer span.added arrives', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const projectionChanges = createProjectionChangeFeed(vaultRoot);

    const peerEvent: AcceptedEvent = {
      clientEventId: 'peer-1',
      dot: { replicaId: 'peer-A', seq: 1 },
      deps: {},
      aggregateId: 'thread-x',
      target: { canonicalUrl: 'https://chat.example.test/thread-x' },
      type: 'review-draft.span.added',
      payload: {
        spanId: 'span-1',
        anchor: {
          textQuote: { exact: 'hi', prefix: '', suffix: '' },
          textPosition: { start: 0, end: 2 },
          cssSelector: 'main',
        },
        quote: 'hi',
        comment: 'remote comment',
        capturedAt: '2026-05-06T12:00:00.000Z',
      },
      acceptedAtMs: 1,
    };
    const importResult = await eventLog.importPeerEvent(peerEvent);
    expect(importResult.imported).toBe(true);

    await runImportProjectors({ vaultRoot, eventLog, projectionChanges }, peerEvent);

    const projection = await readReviewDraft(vaultRoot, 'thread-x');
    expect(projection?.threadUrl).toBe('https://chat.example.test/thread-x');
    expect(projection?.spans).toHaveLength(1);
    expect(projection?.spans[0]?.spanId).toBe('span-1');

    const changes = await projectionChanges.readSince(0);
    expect(changes.changed).toHaveLength(1);
    expect(changes.changed[0]).toMatchObject({
      aggregate: 'review-draft',
      aggregateId: 'thread-x',
      kind: 'upsert',
    });
  });

  it('imported thread.upserted writes _BAC/threads/<id>.json + appends a projection change (F9)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const projectionChanges = createProjectionChangeFeed(vaultRoot);
    const event: AcceptedEvent = {
      clientEventId: 'peer-2',
      dot: { replicaId: 'peer-B', seq: 1 },
      deps: {},
      aggregateId: 'thread-y',
      type: 'thread.upserted',
      payload: {
        bac_id: 'thread-y',
        provider: 'chatgpt',
        threadUrl: 'https://x',
        title: 't',
        lastSeenAt: '2026-05-06T00:00:00.000Z',
      },
      acceptedAtMs: 1,
    };
    await eventLog.importPeerEvent(event);
    await runImportProjectors({ vaultRoot, eventLog, projectionChanges }, event);
    const changes = await projectionChanges.readSince(0);
    // F9 (thread import projector): we DO project thread events
    // now so _BAC/threads/<id>.json fires the vault-changes SSE
    // for the receiving extension.
    expect(changes.changed).toHaveLength(1);
    expect(changes.changed[0]).toMatchObject({
      aggregate: 'thread',
      aggregateId: 'thread-y',
      relPath: '_BAC/threads/thread-y.json',
      kind: 'upsert',
    });
    // The file is on disk and parses as the projection record.
    const { readFile } = await import('node:fs/promises');
    const written = JSON.parse(
      await readFile(`${vaultRoot}/_BAC/threads/thread-y.json`, 'utf8'),
    ) as { bac_id: string; record: { value?: { title?: string } } };
    expect(written.bac_id).toBe('thread-y');
    expect(written.record.value?.title).toBe('t');
  });

  it('imported workstream events are still ignored (still on-demand)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const projectionChanges = createProjectionChangeFeed(vaultRoot);
    const event: AcceptedEvent = {
      clientEventId: 'peer-3',
      dot: { replicaId: 'peer-C', seq: 1 },
      deps: {},
      aggregateId: 'ws-1',
      type: 'workstream.upserted',
      payload: { bac_id: 'ws-1', title: 'ws' },
      acceptedAtMs: 1,
    };
    await eventLog.importPeerEvent(event);
    await runImportProjectors({ vaultRoot, eventLog, projectionChanges }, event);
    const changes = await projectionChanges.readSince(0);
    expect(changes.changed).toHaveLength(0);
  });
});
