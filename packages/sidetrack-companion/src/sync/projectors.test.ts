import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from './causal.js';
import { createEventLog } from './eventLog.js';
import { createProjectionChangeFeed } from './projectionChanges.js';
import { PROJECTED_EVENT_TYPES, runImportProjectors } from './projectors.js';
import { loadOrCreateReplica } from './replicaId.js';
import { readReviewDraft } from '../vault/reviewDrafts.js';
import {
  ANNOTATION_CREATED,
  ANNOTATION_DELETED,
  ANNOTATION_NOTE_SET,
} from '../annotations/events.js';
import { QUEUE_CREATED, QUEUE_STATUS_SET } from '../queue/events.js';
import { DISPATCH_LINKED, DISPATCH_RECORDED } from '../dispatches/events.js';
import {
  THREAD_ARCHIVED,
  THREAD_DELETED,
  THREAD_UNARCHIVED,
  THREAD_UPSERTED,
} from '../threads/events.js';
import { WORKSTREAM_DELETED, WORKSTREAM_UPSERTED } from '../workstreams/events.js';

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

  it('F13 — imported annotation.created writes _BAC/annotations/<id>.json + projection-change row', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const projectionChanges = createProjectionChangeFeed(vaultRoot);
    const event: AcceptedEvent = {
      clientEventId: 'peer-ann-1',
      dot: { replicaId: 'peer-D', seq: 1 },
      deps: {},
      aggregateId: 'ann-1',
      type: ANNOTATION_CREATED,
      payload: {
        bac_id: 'ann-1',
        url: 'https://example.test/page',
        anchor: {
          textQuote: { exact: 'hello', prefix: '', suffix: '' },
          textPosition: { start: 0, end: 5 },
          cssSelector: 'main',
        },
        note: 'remote note',
      },
      acceptedAtMs: 1,
    };
    await eventLog.importPeerEvent(event);
    await runImportProjectors({ vaultRoot, eventLog, projectionChanges }, event);
    const changes = await projectionChanges.readSince(0);
    expect(changes.changed).toHaveLength(1);
    expect(changes.changed[0]).toMatchObject({
      aggregate: 'annotation',
      aggregateId: 'ann-1',
      relPath: '_BAC/annotations/ann-1.json',
      kind: 'upsert',
    });
    const { readFile } = await import('node:fs/promises');
    const written = JSON.parse(
      await readFile(`${vaultRoot}/_BAC/annotations/ann-1.json`, 'utf8'),
    ) as { entry: { bac_id: string; url: string; deleted: boolean } };
    expect(written.entry.bac_id).toBe('ann-1');
    expect(written.entry.url).toBe('https://example.test/page');
    expect(written.entry.deleted).toBe(false);
  });

  it('F13 — annotation.deleted writes a delete-kind projection row', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const projectionChanges = createProjectionChangeFeed(vaultRoot);
    const created: AcceptedEvent = {
      clientEventId: 'peer-ann-2a',
      dot: { replicaId: 'peer-E', seq: 1 },
      deps: {},
      aggregateId: 'ann-2',
      type: ANNOTATION_CREATED,
      payload: {
        bac_id: 'ann-2',
        url: 'https://example.test/page',
        anchor: {
          textQuote: { exact: 'x', prefix: '', suffix: '' },
          textPosition: { start: 0, end: 1 },
          cssSelector: 'main',
        },
        note: 'n',
      },
      acceptedAtMs: 1,
    };
    const deleted: AcceptedEvent = {
      clientEventId: 'peer-ann-2b',
      dot: { replicaId: 'peer-E', seq: 2 },
      deps: { 'peer-E': 1 },
      aggregateId: 'ann-2',
      type: ANNOTATION_DELETED,
      payload: { bac_id: 'ann-2' },
      acceptedAtMs: 2,
    };
    await eventLog.importPeerEvent(created);
    await runImportProjectors({ vaultRoot, eventLog, projectionChanges }, created);
    await eventLog.importPeerEvent(deleted);
    await runImportProjectors({ vaultRoot, eventLog, projectionChanges }, deleted);
    const changes = await projectionChanges.readSince(0);
    expect(changes.changed.map((row) => row.kind)).toEqual(['upsert', 'delete']);
  });

  it('F14 — imported queue.created writes _BAC/queue/<id>.json + projection-change row', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const projectionChanges = createProjectionChangeFeed(vaultRoot);
    const event: AcceptedEvent = {
      clientEventId: 'peer-q-1',
      dot: { replicaId: 'peer-F', seq: 1 },
      deps: {},
      aggregateId: 'q-1',
      type: QUEUE_CREATED,
      payload: { bac_id: 'q-1', text: 'follow up', scope: 'global' },
      acceptedAtMs: 1,
    };
    await eventLog.importPeerEvent(event);
    await runImportProjectors({ vaultRoot, eventLog, projectionChanges }, event);
    const changes = await projectionChanges.readSince(0);
    expect(changes.changed).toHaveLength(1);
    expect(changes.changed[0]).toMatchObject({
      aggregate: 'queue',
      aggregateId: 'q-1',
      relPath: '_BAC/queue/q-1.json',
      kind: 'upsert',
    });
    const { readFile } = await import('node:fs/promises');
    const written = JSON.parse(
      await readFile(`${vaultRoot}/_BAC/queue/q-1.json`, 'utf8'),
    ) as { bac_id: string; base?: { text: string; scope: string } };
    expect(written.bac_id).toBe('q-1');
    expect(written.base?.text).toBe('follow up');
    expect(written.base?.scope).toBe('global');
  });

  it('F15 — imported dispatch.recorded writes _BAC/dispatches/<id>.json + projection-change row', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const projectionChanges = createProjectionChangeFeed(vaultRoot);
    const event: AcceptedEvent = {
      clientEventId: 'peer-d-1',
      dot: { replicaId: 'peer-G', seq: 1 },
      deps: {},
      aggregateId: 'd-1',
      type: DISPATCH_RECORDED,
      payload: {
        bac_id: 'd-1',
        target: { provider: 'chatgpt' },
        createdAt: '2026-05-06T00:00:00.000Z',
        body: 'redacted body',
      },
      acceptedAtMs: 1,
    };
    await eventLog.importPeerEvent(event);
    await runImportProjectors({ vaultRoot, eventLog, projectionChanges }, event);
    const changes = await projectionChanges.readSince(0);
    expect(changes.changed).toHaveLength(1);
    expect(changes.changed[0]).toMatchObject({
      aggregate: 'dispatch',
      aggregateId: 'd-1',
      relPath: '_BAC/dispatches/d-1.json',
      kind: 'upsert',
    });
    const { readFile } = await import('node:fs/promises');
    const written = JSON.parse(
      await readFile(`${vaultRoot}/_BAC/dispatches/d-1.json`, 'utf8'),
    ) as { entry?: { bac_id: string; body: string } };
    expect(written.entry?.bac_id).toBe('d-1');
    expect(written.entry?.body).toBe('redacted body');
  });

  it('F15 — dispatch.linked overwrites the same projection file with a link block', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const projectionChanges = createProjectionChangeFeed(vaultRoot);
    const recorded: AcceptedEvent = {
      clientEventId: 'peer-d-2a',
      dot: { replicaId: 'peer-H', seq: 1 },
      deps: {},
      aggregateId: 'd-2',
      type: DISPATCH_RECORDED,
      payload: {
        bac_id: 'd-2',
        target: { provider: 'chatgpt' },
        createdAt: '2026-05-06T00:00:00.000Z',
        body: 'b',
      },
      acceptedAtMs: 1,
    };
    const linked: AcceptedEvent = {
      clientEventId: 'peer-d-2b',
      dot: { replicaId: 'peer-H', seq: 2 },
      deps: { 'peer-H': 1 },
      aggregateId: 'd-2',
      type: DISPATCH_LINKED,
      payload: { dispatchId: 'd-2', threadId: 'thread-zz' },
      acceptedAtMs: 2,
    };
    await eventLog.importPeerEvent(recorded);
    await eventLog.importPeerEvent(linked);
    await runImportProjectors({ vaultRoot, eventLog, projectionChanges }, recorded);
    await runImportProjectors({ vaultRoot, eventLog, projectionChanges }, linked);
    const { readFile } = await import('node:fs/promises');
    const written = JSON.parse(
      await readFile(`${vaultRoot}/_BAC/dispatches/d-2.json`, 'utf8'),
    ) as { entry?: { bac_id: string }; link?: { dispatchId: string; threadId?: string } };
    expect(written.entry?.bac_id).toBe('d-2');
    expect(written.link?.dispatchId).toBe('d-2');
    expect(written.link?.threadId).toBe('thread-zz');
  });

  it('Invariant B — every emitted aggregate event type has a registered projector', () => {
    // If a new event type is added without a projector, this test
    // fails — surfacing the gap before peers fail to sync. This is
    // the "registry coverage" invariant.
    const expected = new Set<string>([
      THREAD_UPSERTED,
      THREAD_ARCHIVED,
      THREAD_UNARCHIVED,
      THREAD_DELETED,
      WORKSTREAM_UPSERTED,
      WORKSTREAM_DELETED,
      ANNOTATION_CREATED,
      ANNOTATION_NOTE_SET,
      ANNOTATION_DELETED,
      QUEUE_CREATED,
      QUEUE_STATUS_SET,
      DISPATCH_RECORDED,
      DISPATCH_LINKED,
    ]);
    const actual = new Set(PROJECTED_EVENT_TYPES);
    const missing = [...expected].filter((type) => !actual.has(type));
    const extra = [...actual].filter((type) => !expected.has(type));
    expect(missing, `missing projectors for: ${missing.join(', ')}`).toEqual([]);
    expect(extra, `unexpected projectors for: ${extra.join(', ')}`).toEqual([]);
  });

  it('F10 — imported workstream.upserted writes _BAC/workstreams/<id>.json + projection-change row', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const projectionChanges = createProjectionChangeFeed(vaultRoot);
    const event: AcceptedEvent = {
      clientEventId: 'peer-3',
      dot: { replicaId: 'peer-C', seq: 1 },
      deps: {},
      aggregateId: 'ws-1',
      type: 'workstream.upserted',
      payload: { bac_id: 'ws-1', title: 'testsync' },
      acceptedAtMs: 1,
    };
    await eventLog.importPeerEvent(event);
    await runImportProjectors({ vaultRoot, eventLog, projectionChanges }, event);
    const changes = await projectionChanges.readSince(0);
    expect(changes.changed).toHaveLength(1);
    expect(changes.changed[0]).toMatchObject({
      aggregate: 'workstream',
      aggregateId: 'ws-1',
      relPath: '_BAC/workstreams/ws-1.json',
      kind: 'upsert',
    });
    const { readFile } = await import('node:fs/promises');
    const written = JSON.parse(
      await readFile(`${vaultRoot}/_BAC/workstreams/ws-1.json`, 'utf8'),
    ) as { bac_id: string; record: { value?: { title?: string } } };
    expect(written.bac_id).toBe('ws-1');
    expect(written.record.value?.title).toBe('testsync');
  });
});
