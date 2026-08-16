import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { WORKSTREAM_DELETED, WORKSTREAM_UPSERTED } from './events.js';
import { createWorkstreamParentStore } from './workstreamParentStore.js';
import type { AcceptedEvent } from '../sync/causal.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const upsert = (
  bacId: string,
  replicaId: string,
  seq: number,
  overrides: Record<string, unknown> = {},
  acceptedAtMs?: number,
): AcceptedEvent => ({
  clientEventId: `${replicaId}.${String(seq)}.upsert`,
  dot: { replicaId, seq },
  deps: {},
  aggregateId: bacId,
  type: WORKSTREAM_UPSERTED,
  payload: { bac_id: bacId, title: `${bacId} title`, ...overrides },
  acceptedAtMs: acceptedAtMs ?? seq,
});

const deleted = (
  bacId: string,
  replicaId: string,
  seq: number,
  acceptedAtMs?: number,
): AcceptedEvent => ({
  clientEventId: `${replicaId}.${String(seq)}.deleted`,
  dot: { replicaId, seq },
  deps: {},
  aggregateId: bacId,
  type: WORKSTREAM_DELETED,
  payload: { bac_id: bacId },
  acceptedAtMs: acceptedAtMs ?? seq,
});

const irrelevantEvent = (replicaId: string, seq: number): AcceptedEvent => ({
  clientEventId: `priv-${replicaId}-${String(seq)}`,
  dot: { replicaId, seq },
  deps: {},
  aggregateId: 'privacy',
  type: 'privacy.gate.flipped',
  payload: { payloadVersion: 1, gate: 'threads', state: 'open' },
  acceptedAtMs: 0,
});

describe('WorkstreamParentStore', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const tempVault = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'workstream-parent-'));
    dirs.push(d);
    await mkdir(join(d, '_BAC', 'connections'), { recursive: true });
    return d;
  };

  sqliteIt('read() resolves parentId + deleted from ingested events', async () => {
    const vault = await tempVault();
    const store = await createWorkstreamParentStore(vault);
    store.ingestMany([
      upsert('A', 'r1', 1, { parentId: 'root' }),
      upsert('A', 'r1', 2, { parentId: 'root2' }, 2),
      irrelevantEvent('r1', 3),
    ]);
    const record = store.read('A');
    store.close();
    expect(record).toEqual({ bacId: 'A', parentId: 'root2', deleted: false });
  });

  sqliteIt('read() is undefined for a bac_id with no ingested events', async () => {
    const vault = await tempVault();
    const store = await createWorkstreamParentStore(vault);
    store.ingestMany([upsert('A', 'r1', 1)]);
    const record = store.read('never-seen');
    store.close();
    expect(record).toBeUndefined();
  });

  sqliteIt('ingest is idempotent by dot — re-ingesting does not change the resolved value', async () => {
    const vault = await tempVault();
    const store = await createWorkstreamParentStore(vault);
    const events = [upsert('A', 'r1', 1, { parentId: 'p1' }), upsert('A', 'r1', 2, { parentId: 'p2' }, 2)];
    store.ingestMany(events);
    store.ingestMany(events); // second pass must be a no-op
    const record = store.read('A');
    store.close();
    expect(record).toEqual({ bacId: 'A', parentId: 'p2', deleted: false });
  });

  sqliteIt('later-accepted upsert wins regardless of ingest order (LWW convergence)', async () => {
    const vault = await tempVault();
    const store = await createWorkstreamParentStore(vault);
    const early = upsert('A', 'r1', 1, { parentId: 'early-parent' }, 100);
    const late = upsert('A', 'r2', 1, { parentId: 'late-parent' }, 200);
    // Ingest the LATER event first — LWW must still converge on it.
    store.ingestMany([late, early]);
    const record = store.read('A');
    store.close();
    expect(record?.parentId).toBe('late-parent');
  });

  sqliteIt('delete tombstones without erasing parent_id; a later upsert revives', async () => {
    const vault = await tempVault();
    const store = await createWorkstreamParentStore(vault);
    store.ingestMany([
      upsert('A', 'r1', 1, { parentId: 'p1' }, 1),
      deleted('A', 'r1', 2, 2),
    ]);
    const tombstoned = store.read('A');
    expect(tombstoned).toEqual({ bacId: 'A', parentId: 'p1', deleted: true });

    store.ingestMany([upsert('A', 'r1', 3, { parentId: 'p2' }, 3)]);
    const revived = store.read('A');
    store.close();
    expect(revived).toEqual({ bacId: 'A', parentId: 'p2', deleted: false });
  });

  sqliteIt('catchUp ingests only events past the watermark', async () => {
    const vault = await tempVault();
    const store = await createWorkstreamParentStore(vault);
    const events = [
      upsert('A', 'r1', 1, { parentId: 'p1' }, 1),
      upsert('A', 'r1', 2, { parentId: 'p2' }, 2),
    ];
    store.ingestMany(events.slice(0, 1));
    const added = await store.catchUp(events);
    const record = store.read('A');
    store.close();
    expect(added).toBe(1);
    expect(record?.parentId).toBe('p2');
  });

  sqliteIt('rebuildFromJsonl reproduces the same resolved state', async () => {
    const vault = await tempVault();
    const logRoot = join(vault, '_BAC', 'log');
    const events = [
      upsert('A', 'r1', 1, { parentId: 'p1' }, 1),
      upsert('A', 'r1', 2, { parentId: 'p2' }, 2),
    ];
    await mkdir(join(logRoot, 'r1'), { recursive: true });
    await writeFile(
      join(logRoot, 'r1', '0001.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\nnot-json\n`,
      'utf8',
    );
    const store = await createWorkstreamParentStore(vault);
    await store.rebuildFromJsonl(logRoot);
    const record = store.read('A');
    store.close();
    expect(record?.parentId).toBe('p2');
  });

  // ---------------------------------------------------------------------
  // subtreeOf: bounded ancestor-chain walk. Named "subtree" per the F8 W4
  // task spec, but walks UP (self -> parent -> grandparent -> ... -> root)
  // — see this file's header for why an ancestor-chain walk (not a
  // descendant walk) is what a reparent/delete actually needs to
  // invalidate: workstream_parent_of edges are single-level (owned by the
  // PARENT's scope), and delete can never cascade (children block delete
  // at the HTTP layer), so nothing below the affected node ever needs
  // recompute — only the node itself and everything above it in the tree.
  // ---------------------------------------------------------------------
  sqliteIt('subtreeOf walks a deep ancestor chain to the root', async () => {
    const vault = await tempVault();
    const store = await createWorkstreamParentStore(vault);
    // root <- L1 <- L2 <- L3 <- L4 <- L5
    store.ingestMany([
      upsert('L1', 'r1', 1, { parentId: 'root' }, 1),
      upsert('L2', 'r1', 2, { parentId: 'L1' }, 2),
      upsert('L3', 'r1', 3, { parentId: 'L2' }, 3),
      upsert('L4', 'r1', 4, { parentId: 'L3' }, 4),
      upsert('L5', 'r1', 5, { parentId: 'L4' }, 5),
    ]);
    const chain = store.subtreeOf('L5');
    store.close();
    expect(chain).toEqual(['L5', 'L4', 'L3', 'L2', 'L1', 'root']);
  });

  sqliteIt('subtreeOf is cycle-safe against a corrupted parent cycle', async () => {
    const vault = await tempVault();
    const store = await createWorkstreamParentStore(vault);
    // A -> B -> C -> A (a corrupted cycle; must never loop forever).
    store.ingestMany([
      upsert('A', 'r1', 1, { parentId: 'B' }, 1),
      upsert('B', 'r1', 2, { parentId: 'C' }, 2),
      upsert('C', 'r1', 3, { parentId: 'A' }, 3),
    ]);
    const chain = store.subtreeOf('A');
    store.close();
    expect(chain).toEqual(['A', 'B', 'C']);
  });

  sqliteIt('subtreeOf caps depth at 32 hops on a pathologically long chain', async () => {
    const vault = await tempVault();
    const store = await createWorkstreamParentStore(vault);
    const events: AcceptedEvent[] = [];
    // 40-node chain: node_39 -> node_38 -> ... -> node_0 -> root
    for (let i = 39; i >= 0; i -= 1) {
      const parentId = i === 0 ? 'root' : `node_${String(i - 1)}`;
      events.push(upsert(`node_${String(i)}`, 'r1', 40 - i, { parentId }, 40 - i));
    }
    store.ingestMany(events);
    const chain = store.subtreeOf('node_39');
    store.close();
    expect(chain.length).toBe(32);
    expect(chain[0]).toBe('node_39');
  });

  sqliteIt('subtreeOf returns just [bacId] for a never-observed id', async () => {
    const vault = await tempVault();
    const store = await createWorkstreamParentStore(vault);
    const chain = store.subtreeOf('ghost');
    store.close();
    expect(chain).toEqual(['ghost']);
  });

  sqliteIt(
    'reparent: subtreeOf before + after ingest yields both the old and new ancestor chains',
    async () => {
      const vault = await tempVault();
      const store = await createWorkstreamParentStore(vault);
      // Two separate trees: A <- B, and C (standalone).
      store.ingestMany([
        upsert('A', 'r1', 1, {}, 1),
        upsert('B', 'r1', 2, { parentId: 'A' }, 2),
        upsert('C', 'r1', 3, {}, 3),
      ]);
      const beforeChain = store.subtreeOf('B');
      expect(beforeChain).toEqual(['B', 'A']);

      // Reparent B from A to C.
      store.ingestMany([upsert('B', 'r1', 4, { parentId: 'C' }, 4)]);
      const afterChain = store.subtreeOf('B');
      store.close();
      expect(afterChain).toEqual(['B', 'C']);

      const affected = new Set([...beforeChain, ...afterChain]);
      expect(affected).toEqual(new Set(['B', 'A', 'C']));
    },
  );

  sqliteIt('multiple workstreams are tracked independently', async () => {
    const vault = await tempVault();
    const store = await createWorkstreamParentStore(vault);
    store.ingestMany([
      upsert('A', 'r1', 1, { parentId: 'root' }, 1),
      upsert('B', 'r1', 2, { parentId: 'other-root' }, 2),
    ]);
    const a = store.read('A');
    const b = store.read('B');
    store.close();
    expect(a?.parentId).toBe('root');
    expect(b?.parentId).toBe('other-root');
  });
});
