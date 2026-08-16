import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { activeMembershipRows, primaryMembershipRow, WORKSTREAM_MEMBERSHIP_REMOVED, WORKSTREAM_MEMBERSHIP_SET } from './membershipEvents.js';
import { createWorkstreamMembershipStore } from './workstreamMembershipStore.js';
import type { AcceptedEvent } from '../sync/causal.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const setEvent = (input: {
  readonly subjectKind: 'canonical-url' | 'thread' | 'tab-session';
  readonly subjectId: string;
  readonly workstreamId: string;
  readonly role: 'primary' | 'secondary';
  readonly replicaId: string;
  readonly seq: number;
  readonly atMs: number;
  readonly provenance?: 'user-filed' | 'ai-suggested-accepted' | 'prototype-matched';
}): AcceptedEvent => ({
  clientEventId: `${input.replicaId}.${String(input.seq)}`,
  dot: { replicaId: input.replicaId, seq: input.seq },
  deps: {},
  aggregateId: `workstream-membership:${input.subjectKind}:${input.subjectId}:${input.workstreamId}`,
  type: WORKSTREAM_MEMBERSHIP_SET,
  payload: {
    payloadVersion: 1,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    workstreamId: input.workstreamId,
    role: input.role,
    provenance: input.provenance ?? 'user-filed',
  },
  acceptedAtMs: input.atMs,
});

const removedEvent = (input: {
  readonly subjectKind: 'canonical-url' | 'thread' | 'tab-session';
  readonly subjectId: string;
  readonly workstreamId: string;
  readonly replicaId: string;
  readonly seq: number;
  readonly atMs: number;
}): AcceptedEvent => ({
  clientEventId: `${input.replicaId}.${String(input.seq)}`,
  dot: { replicaId: input.replicaId, seq: input.seq },
  deps: {},
  aggregateId: `workstream-membership:${input.subjectKind}:${input.subjectId}:${input.workstreamId}`,
  type: WORKSTREAM_MEMBERSHIP_REMOVED,
  payload: {
    payloadVersion: 1,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    workstreamId: input.workstreamId,
    reason: 'user-removed',
  },
  acceptedAtMs: input.atMs,
});

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

const makeVault = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-membership-store-'));
  tempDirs.push(dir);
  await mkdir(join(dir, '_BAC', 'connections'), { recursive: true });
  return dir;
};

describe('workstreamMembershipStore', () => {
  sqliteIt('ingest + read round-trips a multi-workstream subject', async () => {
    const vaultRoot = await makeVault();
    const store = await createWorkstreamMembershipStore(vaultRoot);
    try {
      store.ingestMany([
        setEvent({
          subjectKind: 'canonical-url',
          subjectId: 'https://a.test/x',
          workstreamId: 'ws-1',
          role: 'primary',
          replicaId: 'r1',
          seq: 1,
          atMs: 1_000,
        }),
        setEvent({
          subjectKind: 'canonical-url',
          subjectId: 'https://a.test/x',
          workstreamId: 'ws-2',
          role: 'secondary',
          replicaId: 'r1',
          seq: 2,
          atMs: 2_000,
        }),
      ]);
      const rows = store.read('canonical-url', 'https://a.test/x');
      expect(activeMembershipRows(rows).map((r) => r.workstreamId)).toEqual(['ws-1', 'ws-2']);
      expect(primaryMembershipRow(rows)?.workstreamId).toBe('ws-1');
    } finally {
      store.close();
    }
  });

  sqliteIt('is idempotent under duplicate dot re-ingest', async () => {
    const vaultRoot = await makeVault();
    const store = await createWorkstreamMembershipStore(vaultRoot);
    try {
      const event = setEvent({
        subjectKind: 'canonical-url',
        subjectId: 'https://a.test/x',
        workstreamId: 'ws-1',
        role: 'primary',
        replicaId: 'r1',
        seq: 1,
        atMs: 1_000,
      });
      store.ingest(event);
      store.ingest(event);
      store.ingest(event);
      const rows = store.read('canonical-url', 'https://a.test/x');
      expect(activeMembershipRows(rows)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  sqliteIt('a remove then re-ingest of the same events converges (order-independent bucket)', async () => {
    const vaultRoot = await makeVault();
    const store = await createWorkstreamMembershipStore(vaultRoot);
    try {
      store.ingestMany([
        setEvent({
          subjectKind: 'canonical-url',
          subjectId: 'https://a.test/x',
          workstreamId: 'ws-1',
          role: 'secondary',
          replicaId: 'r1',
          seq: 1,
          atMs: 1_000,
        }),
        removedEvent({
          subjectKind: 'canonical-url',
          subjectId: 'https://a.test/x',
          workstreamId: 'ws-1',
          replicaId: 'r1',
          seq: 2,
          atMs: 2_000,
        }),
      ]);
      expect(activeMembershipRows(store.read('canonical-url', 'https://a.test/x'))).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  sqliteIt('subjectsInWorkstream reverse-index reflects active members only', async () => {
    const vaultRoot = await makeVault();
    const store = await createWorkstreamMembershipStore(vaultRoot);
    try {
      store.ingestMany([
        setEvent({
          subjectKind: 'canonical-url',
          subjectId: 'https://a.test/x',
          workstreamId: 'ws-1',
          role: 'primary',
          replicaId: 'r1',
          seq: 1,
          atMs: 1_000,
        }),
        setEvent({
          subjectKind: 'canonical-url',
          subjectId: 'https://a.test/y',
          workstreamId: 'ws-1',
          role: 'secondary',
          replicaId: 'r1',
          seq: 2,
          atMs: 2_000,
        }),
        setEvent({
          subjectKind: 'thread',
          subjectId: 'bac_1',
          workstreamId: 'ws-1',
          role: 'secondary',
          replicaId: 'r1',
          seq: 3,
          atMs: 3_000,
        }),
        removedEvent({
          subjectKind: 'canonical-url',
          subjectId: 'https://a.test/y',
          workstreamId: 'ws-1',
          replicaId: 'r1',
          seq: 4,
          atMs: 4_000,
        }),
      ]);
      const members = store.subjectsInWorkstream('ws-1');
      expect(members).toEqual([
        { subjectKind: 'canonical-url', subjectId: 'https://a.test/x' },
        { subjectKind: 'thread', subjectId: 'bac_1' },
      ]);
    } finally {
      store.close();
    }
  });

  sqliteIt('catchUp skips events at or below the persisted watermark', async () => {
    const vaultRoot = await makeVault();
    const store = await createWorkstreamMembershipStore(vaultRoot);
    try {
      const first = setEvent({
        subjectKind: 'canonical-url',
        subjectId: 'https://a.test/x',
        workstreamId: 'ws-1',
        role: 'primary',
        replicaId: 'r1',
        seq: 1,
        atMs: 1_000,
      });
      await store.catchUp([first]);
      expect(await store.catchUp([first])).toBe(0);
      const second = setEvent({
        subjectKind: 'canonical-url',
        subjectId: 'https://a.test/x',
        workstreamId: 'ws-2',
        role: 'secondary',
        replicaId: 'r1',
        seq: 2,
        atMs: 2_000,
      });
      expect(await store.catchUp([first, second])).toBe(1);
    } finally {
      store.close();
    }
  });

  sqliteIt('rebuildFromJsonl replays the log root from scratch', async () => {
    const vaultRoot = await makeVault();
    const logRoot = join(vaultRoot, '_BAC', 'log');
    const replicaDir = join(logRoot, 'r1');
    await mkdir(replicaDir, { recursive: true });
    const events = [
      setEvent({
        subjectKind: 'canonical-url',
        subjectId: 'https://a.test/x',
        workstreamId: 'ws-1',
        role: 'primary',
        replicaId: 'r1',
        seq: 1,
        atMs: 1_000,
      }),
      setEvent({
        subjectKind: 'canonical-url',
        subjectId: 'https://a.test/x',
        workstreamId: 'ws-2',
        role: 'secondary',
        replicaId: 'r1',
        seq: 2,
        atMs: 2_000,
      }),
    ];
    await writeFile(
      join(replicaDir, '2026-08-16.jsonl'),
      events.map((event) => JSON.stringify(event)).join('\n'),
      'utf8',
    );
    const store = await createWorkstreamMembershipStore(vaultRoot);
    try {
      expect(store.read('canonical-url', 'https://a.test/x')).toHaveLength(0);
      await store.rebuildFromJsonl(logRoot);
      const rows = activeMembershipRows(store.read('canonical-url', 'https://a.test/x'));
      expect(rows.map((r) => r.workstreamId)).toEqual(['ws-1', 'ws-2']);
    } finally {
      store.close();
    }
  });
});
