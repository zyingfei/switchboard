import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { createProjectionChangeFeed } from '../projectionChanges.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createProjectionMaterializer } from './projectionMaterializer.js';
import { createSyncContractRunner } from './runner.js';

// Lane 1 contract gates exercised at the unit level:
//
//   L1-G8 — Byte-shape-compatible local + peer projection.
//   L1-G10 — Local + peer symmetric materialization.
//
// We don't spin up a full HTTP server. Instead we drive both paths
// through the runner directly: one replica appends locally, another
// imports the same event as a peer. After both paths run, the
// projection files written by the projection materializer must be
// byte-identical.

describe('Lane 1 contract — symmetric local/peer materialization (L1-G8 + L1-G10)', () => {
  let vaultA: string;
  let vaultB: string;

  beforeEach(async () => {
    vaultA = await mkdtemp(join(tmpdir(), 'sidetrack-l1-sym-A-'));
    vaultB = await mkdtemp(join(tmpdir(), 'sidetrack-l1-sym-B-'));
  });

  afterEach(async () => {
    await rm(vaultA, { recursive: true, force: true });
    await rm(vaultB, { recursive: true, force: true });
  });

  it('thread.upserted: local accept on A and peer import on B produce byte-identical projection files', async () => {
    const replicaA = await loadOrCreateReplica(vaultA);
    const replicaB = await loadOrCreateReplica(vaultB);
    const eventLogA = createEventLog(vaultA, replicaA);
    const eventLogB = createEventLog(vaultB, replicaB);
    const changesA = createProjectionChangeFeed(vaultA);
    const changesB = createProjectionChangeFeed(vaultB);

    const runnerA = createSyncContractRunner();
    const runnerB = createSyncContractRunner();
    runnerA.register(
      createProjectionMaterializer({ vaultRoot: vaultA, eventLog: eventLogA, projectionChanges: changesA }),
    );
    runnerB.register(
      createProjectionMaterializer({ vaultRoot: vaultB, eventLog: eventLogB, projectionChanges: changesB }),
    );

    // A locally accepts the event (we use appendServerObserved to
    // mirror what the production POST /v1/threads handler does post
    // L1.S4). The runner's `origin: 'local'` would normally fire via
    // the runtime decorator; here we drive it directly so we assert
    // the materializer's symmetric behavior.
    const acceptedOnA = await eventLogA.appendServerObserved({
      clientEventId: 'sym-1',
      aggregateId: 'th-1',
      type: 'thread.upserted',
      payload: {
        bac_id: 'th-1',
        provider: 'chatgpt',
        threadUrl: 'https://example.test/sym',
        title: 'Symmetric materialization probe',
        lastSeenAt: '2026-05-07T00:00:00.000Z',
      },
    });
    runnerA.onAcceptedEvent(acceptedOnA, { origin: 'local' });
    await runnerA.awaitIdle();

    // B imports the same event as a peer — runner is fired by the
    // relay subscriber in production; here we drive it directly.
    await eventLogB.importPeerEvent(acceptedOnA);
    runnerB.onAcceptedEvent(acceptedOnA, { origin: 'peer' });
    await runnerB.awaitIdle();

    // L1-G8: byte-identical projection files at the new projection
    // subpath. Local + peer produce the same content because the
    // projector is a deterministic function of the merged log AND
    // both replicas now hold the same event.
    const fileA = await readFile(`${vaultA}/_BAC/threads/projections/th-1.json`, 'utf8');
    const fileB = await readFile(`${vaultB}/_BAC/threads/projections/th-1.json`, 'utf8');
    expect(fileA).toBe(fileB);

    // L1-G10: both local and peer paths produced the projection
    // file. Reading either replica's projection feed gives the same
    // shape — sync-aware consumers see one canonical surface
    // regardless of origin.
    const changesEmittedA = await changesA.readSince(0);
    const changesEmittedB = await changesB.readSince(0);
    expect(changesEmittedA.changed).toHaveLength(1);
    expect(changesEmittedB.changed).toHaveLength(1);
    expect(changesEmittedA.changed[0]).toMatchObject({
      aggregate: 'thread',
      aggregateId: 'th-1',
      relPath: '_BAC/threads/projections/th-1.json',
      kind: 'upsert',
    });
    expect(changesEmittedB.changed[0]).toMatchObject({
      aggregate: 'thread',
      aggregateId: 'th-1',
      relPath: '_BAC/threads/projections/th-1.json',
      kind: 'upsert',
    });
  });

  it('annotation.created: same byte-shape on local and peer', async () => {
    const replicaA = await loadOrCreateReplica(vaultA);
    const replicaB = await loadOrCreateReplica(vaultB);
    const eventLogA = createEventLog(vaultA, replicaA);
    const eventLogB = createEventLog(vaultB, replicaB);
    const changesA = createProjectionChangeFeed(vaultA);
    const changesB = createProjectionChangeFeed(vaultB);

    const runnerA = createSyncContractRunner();
    const runnerB = createSyncContractRunner();
    runnerA.register(
      createProjectionMaterializer({ vaultRoot: vaultA, eventLog: eventLogA, projectionChanges: changesA }),
    );
    runnerB.register(
      createProjectionMaterializer({ vaultRoot: vaultB, eventLog: eventLogB, projectionChanges: changesB }),
    );

    const accepted: AcceptedEvent = await eventLogA.appendServerObserved({
      clientEventId: 'sym-ann-1',
      aggregateId: 'ann-1',
      type: 'annotation.created',
      payload: {
        bac_id: 'ann-1',
        url: 'https://example.test/page',
        anchor: {
          textQuote: { exact: 'sync', prefix: '', suffix: '' },
          textPosition: { start: 0, end: 4 },
          cssSelector: 'main',
        },
        note: 'symmetric annotation',
      },
    });
    runnerA.onAcceptedEvent(accepted, { origin: 'local' });
    await runnerA.awaitIdle();

    await eventLogB.importPeerEvent(accepted);
    runnerB.onAcceptedEvent(accepted, { origin: 'peer' });
    await runnerB.awaitIdle();

    const fileA = await readFile(`${vaultA}/_BAC/annotations/projections/ann-1.json`, 'utf8');
    const fileB = await readFile(`${vaultB}/_BAC/annotations/projections/ann-1.json`, 'utf8');
    expect(fileA).toBe(fileB);
  });
});
