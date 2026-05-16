import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from './snapshot.js';
import type { ConnectionsSnapshot } from './types.js';

const buildSnapshot = (revisionId: string): ConnectionsSnapshot => ({
  scope: {},
  nodes: [],
  edges: [],
  updatedAt: '2026-05-12T00:00:00.000Z',
  nodeCount: 0,
  edgeCount: 0,
  snapshotRevision: revisionId,
});

describe('connectionsStore — Stage 5.2 W5 store-level skip-write', () => {
  let vaultRoot: string;
  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-store-skipwrite-'));
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const currentPath = (): string => join(vaultRoot, '_BAC', 'connections', 'current.json');
  const mtimeMs = async (): Promise<number> => (await stat(currentPath())).mtimeMs;

  it('writes the file on first putCurrent', async () => {
    const store = createConnectionsStore(vaultRoot);
    await store.putCurrent(buildSnapshot('rev-a'));
    const t1 = await mtimeMs();
    expect(t1).toBeGreaterThan(0);
  });

  it('skips disk write on a second putCurrent with the same snapshotRevision', async () => {
    const store = createConnectionsStore(vaultRoot);
    await store.putCurrent(buildSnapshot('rev-a'));
    const t1 = await mtimeMs();
    // Force a small wall-clock gap so a subsequent write would produce a
    // different mtime.
    await new Promise((r) => setTimeout(r, 30));
    await store.putCurrent(buildSnapshot('rev-a'));
    const t2 = await mtimeMs();
    expect(t2).toBe(t1);
  });

  it('writes again when snapshotRevision changes', async () => {
    const store = createConnectionsStore(vaultRoot);
    await store.putCurrent(buildSnapshot('rev-a'));
    const t1 = await mtimeMs();
    await new Promise((r) => setTimeout(r, 30));
    await store.putCurrent(buildSnapshot('rev-b'));
    const t2 = await mtimeMs();
    expect(t2).toBeGreaterThan(t1);
  });

  it('always writes when snapshotRevision is undefined (pre-R4 back-compat)', async () => {
    const store = createConnectionsStore(vaultRoot);
    const withRev = buildSnapshot('ignored');
    const { snapshotRevision: _drop1, ...snap1 } = withRev;
    const { snapshotRevision: _drop2, ...snap2 } = buildSnapshot('ignored');
    void _drop1;
    void _drop2;
    await store.putCurrent(snap1 as ConnectionsSnapshot);
    const t1 = await mtimeMs();
    await new Promise((r) => setTimeout(r, 30));
    await store.putCurrent(snap2 as ConnectionsSnapshot);
    const t2 = await mtimeMs();
    // Without a revision, we can't dedupe, so each call writes.
    expect(t2).toBeGreaterThan(t1);
  });

  it('caches current snapshot reads until another process replaces the file', async () => {
    const store = createConnectionsStore(vaultRoot);
    await store.putCurrent(buildSnapshot('rev-a'));

    const first = await store.readCurrent();
    const second = await store.readCurrent();
    expect(second).toBe(first);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const externalWriter = createConnectionsStore(vaultRoot);
    await externalWriter.putCurrent(buildSnapshot('rev-b'));

    const third = await store.readCurrent();
    expect(third).not.toBe(first);
    expect(third?.snapshotRevision).toBe('rev-b');
  });
});
