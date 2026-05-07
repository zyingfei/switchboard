import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent, VersionVector } from './causal.js';
import { createEventLog } from './eventLog.js';
import { createProjectionChangeFeed } from './projectionChanges.js';
import { runImportProjectors } from './projectors.js';
import { loadOrCreateReplica } from './replicaId.js';

// Sync contract matrix.
//
// For every aggregate that sync supports, this asserts the same five
// invariants:
//
//   1. After A appends + projects, A's `_BAC/<dir>/<id>.json` exists.
//   2. After B imports A's event + projects, B's projection file
//      exists at the same relative path.
//   3. The two projection files have byte-identical content (the
//      projector is deterministic given the same merged log).
//   4. Re-running the projector on the same merged log produces the
//      same content (idempotent).
//   5. A second event for the same aggregate, propagated A → B, lands
//      with deps that causally observe the prior event (the projection
//      collapses cleanly rather than surfacing a spurious conflict).
//
// Adding a new aggregate to the registry without adding a row here is
// caught by Invariant B's coverage test (registry membership), but
// this matrix is what proves the registry's projector actually works
// end-to-end across two replicas. Future aggregates: add a `case`
// below.

interface MatrixCase {
  readonly name: string;
  readonly relDir: string;
  readonly aggregateId: string;
  readonly first: () => Pick<
    AcceptedEvent,
    'type' | 'payload' | 'aggregateId' | 'target'
  >;
  readonly second: (priorVector: VersionVector) => Pick<
    AcceptedEvent,
    'type' | 'payload' | 'aggregateId' | 'target'
  > | null;
}

const cases: readonly MatrixCase[] = [
  {
    name: 'thread',
    relDir: '_BAC/threads/projections',
    aggregateId: 'th-1',
    first: () => ({
      aggregateId: 'th-1',
      type: 'thread.upserted',
      payload: {
        bac_id: 'th-1',
        provider: 'chatgpt',
        threadUrl: 'https://x',
        title: 'A',
        lastSeenAt: '2026-05-06T00:00:00.000Z',
      },
    }),
    second: () => ({
      aggregateId: 'th-1',
      type: 'thread.archived',
      payload: { bac_id: 'th-1' },
    }),
  },
  {
    name: 'workstream',
    relDir: '_BAC/workstreams/projections',
    aggregateId: 'ws-1',
    first: () => ({
      aggregateId: 'ws-1',
      type: 'workstream.upserted',
      payload: { bac_id: 'ws-1', title: 'Group' },
    }),
    second: () => ({
      aggregateId: 'ws-1',
      type: 'workstream.upserted',
      payload: { bac_id: 'ws-1', title: 'Group renamed' },
    }),
  },
  {
    name: 'annotation',
    relDir: '_BAC/annotations/projections',
    aggregateId: 'ann-1',
    first: () => ({
      aggregateId: 'ann-1',
      type: 'annotation.created',
      payload: {
        bac_id: 'ann-1',
        url: 'https://example.test/page',
        anchor: {
          textQuote: { exact: 'hi', prefix: '', suffix: '' },
          textPosition: { start: 0, end: 2 },
          cssSelector: 'main',
        },
        note: 'first',
      },
    }),
    second: () => ({
      aggregateId: 'ann-1',
      type: 'annotation.noteSet',
      payload: { bac_id: 'ann-1', note: 'second' },
    }),
  },
  {
    name: 'queue',
    relDir: '_BAC/queue/projections',
    aggregateId: 'q-1',
    first: () => ({
      aggregateId: 'q-1',
      type: 'queue.created',
      payload: { bac_id: 'q-1', text: 'follow up', scope: 'global' },
    }),
    second: () => ({
      aggregateId: 'q-1',
      type: 'queue.statusSet',
      payload: { bac_id: 'q-1', status: 'done' },
    }),
  },
  {
    name: 'dispatch',
    relDir: '_BAC/dispatches/projections',
    aggregateId: 'd-1',
    first: () => ({
      aggregateId: 'd-1',
      type: 'dispatch.recorded',
      payload: {
        bac_id: 'd-1',
        target: { provider: 'chatgpt' },
        createdAt: '2026-05-06T00:00:00.000Z',
        body: 'redacted body',
      },
    }),
    second: () => ({
      aggregateId: 'd-1',
      type: 'dispatch.linked',
      payload: { dispatchId: 'd-1', threadId: 'th-zz' },
    }),
  },
  {
    name: 'review-draft (span.added then comment.set)',
    relDir: '_BAC/review-drafts',
    aggregateId: 'rev-1',
    first: () => ({
      aggregateId: 'rev-1',
      target: { canonicalUrl: 'https://chat.example.test/rev-1' },
      type: 'review-draft.span.added',
      payload: {
        spanId: 'span-1',
        anchor: {
          textQuote: { exact: 'hi', prefix: '', suffix: '' },
          textPosition: { start: 0, end: 2 },
          cssSelector: 'main',
        },
        quote: 'hi',
        comment: 'note',
        capturedAt: '2026-05-06T12:00:00.000Z',
      },
    }),
    second: () => ({
      aggregateId: 'rev-1',
      target: { canonicalUrl: 'https://chat.example.test/rev-1' },
      type: 'review-draft.comment.set',
      payload: { spanId: 'span-1', comment: 'updated note' },
    }),
  },
];

describe('sync contract matrix', () => {
  let vaultA: string;
  let vaultB: string;

  beforeEach(async () => {
    vaultA = await mkdtemp(join(tmpdir(), 'sidetrack-contract-A-'));
    vaultB = await mkdtemp(join(tmpdir(), 'sidetrack-contract-B-'));
  });

  afterEach(async () => {
    await rm(vaultA, { recursive: true, force: true });
    await rm(vaultB, { recursive: true, force: true });
  });

  for (const matrixCase of cases) {
    it(`${matrixCase.name}: A → B convergence + idempotent re-projection`, async () => {
      const replicaA = await loadOrCreateReplica(vaultA);
      const replicaB = await loadOrCreateReplica(vaultB);
      const eventLogA = createEventLog(vaultA, replicaA);
      const eventLogB = createEventLog(vaultB, replicaB);
      const changesA = createProjectionChangeFeed(vaultA);
      const changesB = createProjectionChangeFeed(vaultB);

      // First event from A's perspective. Use importPeerEvent so the
      // dot is fixed (deterministic across the test); the contract is
      // about projection convergence, not local appendClient
      // mechanics.
      const firstEvent: AcceptedEvent = {
        clientEventId: `${matrixCase.name}-1`,
        dot: { replicaId: 'peer-A', seq: 1 },
        deps: {},
        acceptedAtMs: 1,
        ...matrixCase.first(),
      };
      await eventLogA.importPeerEvent(firstEvent);
      await runImportProjectors(
        { vaultRoot: vaultA, eventLog: eventLogA, projectionChanges: changesA },
        firstEvent,
      );
      // B receives the same event.
      await eventLogB.importPeerEvent(firstEvent);
      await runImportProjectors(
        { vaultRoot: vaultB, eventLog: eventLogB, projectionChanges: changesB },
        firstEvent,
      );

      const fileName = `${matrixCase.aggregateId}.json`;
      const pathA = join(vaultA, ...matrixCase.relDir.split('/'), fileName);
      const pathB = join(vaultB, ...matrixCase.relDir.split('/'), fileName);
      const contentA = await readFile(pathA, 'utf8');
      const contentB = await readFile(pathB, 'utf8');
      expect(contentA).toBe(contentB);

      // Idempotent re-projection — running again produces the same
      // content.
      await runImportProjectors(
        { vaultRoot: vaultA, eventLog: eventLogA, projectionChanges: changesA },
        firstEvent,
      );
      const contentAReproject = await readFile(pathA, 'utf8');
      expect(contentAReproject).toBe(contentA);

      // Second event causally depends on the first. Send via A; A's
      // projector overwrites; mirror to B; both still match.
      const secondPayload = matrixCase.second({ 'peer-A': 1 });
      if (secondPayload === null) return;
      const secondEvent: AcceptedEvent = {
        clientEventId: `${matrixCase.name}-2`,
        dot: { replicaId: 'peer-A', seq: 2 },
        deps: { 'peer-A': 1 },
        acceptedAtMs: 2,
        ...secondPayload,
      };
      await eventLogA.importPeerEvent(secondEvent);
      await runImportProjectors(
        { vaultRoot: vaultA, eventLog: eventLogA, projectionChanges: changesA },
        secondEvent,
      );
      await eventLogB.importPeerEvent(secondEvent);
      await runImportProjectors(
        { vaultRoot: vaultB, eventLog: eventLogB, projectionChanges: changesB },
        secondEvent,
      );
      const finalA = await readFile(pathA, 'utf8');
      const finalB = await readFile(pathB, 'utf8');
      expect(finalA).toBe(finalB);
      // Final projection must be different from the first projection
      // — the second event actually changed something. Without this
      // guard, a buggy projector that ignored the second event would
      // pass the convergence check.
      expect(finalA).not.toBe(contentA);
    });
  }
});
