import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildMultiFlowFixture,
  CROSS_FLOW_NODES,
  FLOW_NODES,
  NODE_IDS,
  flowExclusiveNodes,
} from './__fixtures__/multiFlowStory.js';
import { buildConnectionsSnapshot, subgraphForNode } from './snapshot.js';

// Layer-1 integration test for the parallel-flow user story.
//
// Three woven research flows (CVE, Postgres MERGE, Sidetrack project
// review) plus an intentional cross-flow URL coincidence. The fixture
// is the load-bearing artifact — every assertion derives from it
// rather than hand-listing nodes/edges, so the test stays correct as
// the fixture evolves.

const COMPANION_EMITTED_KINDS: readonly string[] = [
  'thread_in_workstream',
  'workstream_parent_of',
  'dispatch_from_thread',
  'dispatch_in_workstream',
  'dispatch_reply_landed_in_thread',
  'dispatch_requested_coding_session',
  'queue_targets_thread',
  'queue_targets_workstream',
  // 'reminder_for_thread' was emitted per chatgpt capture; filtered
  // from the snapshot projection on 2026-05-27 (26bdcbce) — the records
  // were vestigial (never wired to an inbox UI). See snapshot.ts and the
  // dedicated regression test in snapshot.test.ts. Re-add here if the
  // projection is re-enabled (gate: r.status !== 'new' OR a flag).
  'coding_session_in_workstream',
  'timeline_same_url_as_thread',
  'annotation_targets_thread',
  'thread_references_url',
  'dispatch_references_url',
  'annotation_references_url',
  'thread_quotes_thread',
  'thread_text_mentions_search_query',
];

describe('connections — multi-flow user-story integration', () => {
  const snap = buildConnectionsSnapshot(buildMultiFlowFixture());

  it('emits every companion-supported edge kind at least once', () => {
    const actual = new Set<string>(snap.edges.map((e) => e.kind as string));
    const missing = COMPANION_EMITTED_KINDS.filter((k) => !actual.has(k));
    expect(missing).toEqual([]);
  });

  it('Flow A (CVE) anchored on ws_security: includes its own nodes, excludes B and C', () => {
    const sub = subgraphForNode(snap, FLOW_NODES.A.workstream, 2);
    const ids = new Set(sub.nodes.map((n) => n.id));
    // Core flow A nodes that should be present at hops=2 from ws_security.
    expect(ids.has(FLOW_NODES.A.workstream)).toBe(true);
    expect(ids.has(FLOW_NODES.A.parentWorkstream)).toBe(true);
    for (const tid of FLOW_NODES.A.threads) expect(ids.has(tid)).toBe(true);
    for (const did of FLOW_NODES.A.dispatches) expect(ids.has(did)).toBe(true);
    for (const cid of FLOW_NODES.A.codingSessions) expect(ids.has(cid)).toBe(true);
    for (const qid of FLOW_NODES.A.queueItems) expect(ids.has(qid)).toBe(true);
    // reminder_for_thread projection is suppressed (26bdcbce) so the
    // reminder node never enters the graph — asserted absent below.
    for (const rid of FLOW_NODES.A.reminders) expect(ids.has(rid)).toBe(false);
    // No Flow-B-exclusive node should leak in.
    for (const id of flowExclusiveNodes('B')) {
      expect(ids.has(id), `B-exclusive ${id} leaked into A`).toBe(false);
    }
    // No Flow-C-exclusive node should leak in.
    for (const id of flowExclusiveNodes('C')) {
      expect(ids.has(id), `C-exclusive ${id} leaked into A`).toBe(false);
    }
  });

  it('Flow B (Postgres) anchored on ws_postgres: own nodes only', () => {
    const sub = subgraphForNode(snap, FLOW_NODES.B.workstream, 2);
    const ids = new Set(sub.nodes.map((n) => n.id));
    expect(ids.has(FLOW_NODES.B.workstream)).toBe(true);
    for (const tid of FLOW_NODES.B.threads) expect(ids.has(tid)).toBe(true);
    for (const did of FLOW_NODES.B.dispatches) expect(ids.has(did)).toBe(true);
    for (const qid of FLOW_NODES.B.queueItems) expect(ids.has(qid)).toBe(true);
    for (const id of flowExclusiveNodes('A')) {
      expect(ids.has(id), `A-exclusive ${id} leaked into B`).toBe(false);
    }
    for (const id of flowExclusiveNodes('C')) {
      expect(ids.has(id), `C-exclusive ${id} leaked into B`).toBe(false);
    }
  });

  it('Flow C (Sidetrack) anchored on ws_sidetrack: own nodes only', () => {
    const sub = subgraphForNode(snap, FLOW_NODES.C.workstream, 2);
    const ids = new Set(sub.nodes.map((n) => n.id));
    expect(ids.has(FLOW_NODES.C.workstream)).toBe(true);
    for (const tid of FLOW_NODES.C.threads) expect(ids.has(tid)).toBe(true);
    for (const did of FLOW_NODES.C.dispatches) expect(ids.has(did)).toBe(true);
    for (const cid of FLOW_NODES.C.codingSessions) expect(ids.has(cid)).toBe(true);
    for (const id of flowExclusiveNodes('A')) {
      expect(ids.has(id), `A-exclusive ${id} leaked into C`).toBe(false);
    }
    for (const id of flowExclusiveNodes('B')) {
      expect(ids.has(id), `B-exclusive ${id} leaked into C`).toBe(false);
    }
  });

  it('cross-flow HN URL anchor bridges Flows B and C (the intentional coincidence)', () => {
    const sub = subgraphForNode(snap, CROSS_FLOW_NODES.hnPgMergeVisit, 1);
    const ids = new Set(sub.nodes.map((n) => n.id));
    // Both Postgres and Sidetrack Claude threads cite this HN URL in
    // their captured user turns → 1-hop neighborhood reaches both.
    expect(ids.has(NODE_IDS.T_PG_CLAUDE)).toBe(true);
    expect(ids.has(NODE_IDS.T_SB_CLAUDE)).toBe(true);
  });

  it('produces a thread_quotes_thread edge inside each flow (Claude → ChatGPT pair)', () => {
    const quotes = snap.edges.filter((e) => e.kind === 'thread_quotes_thread');
    const pairs = new Set(quotes.map((e) => `${e.fromNodeId}|${e.toNodeId}`));
    // For each flow, at least one direction of the quote pair fires.
    const present = (a: string, b: string): boolean =>
      pairs.has(`${a}|${b}`) || pairs.has(`${b}|${a}`);
    expect(present(NODE_IDS.T_CVE_CLAUDE, NODE_IDS.T_CVE_CHATGPT)).toBe(true);
    expect(present(NODE_IDS.T_PG_CLAUDE, NODE_IDS.T_PG_CHATGPT)).toBe(true);
    expect(present(NODE_IDS.T_SB_CLAUDE, NODE_IDS.T_SB_CHATGPT)).toBe(true);
    // Each emitted edge carries the matched-shingle hash prefix.
    for (const e of quotes) {
      expect(e.producedBy.recordId, `recordId missing on ${e.id}`).toBeDefined();
      expect(e.producedBy.recordId?.length).toBe(12);
    }
  });

  // Fixture dumper — when MULTI_FLOW_DUMP=1 is set, writes the
  // computed snapshot to the extension's test fixtures dir so the
  // Layer-2 render test can import it without crossing package
  // boundaries. Otherwise inert.
  it('dumps the snapshot + per-anchor subgraphs for the extension render test (MULTI_FLOW_DUMP=1)', () => {
    if (process.env['MULTI_FLOW_DUMP'] !== '1') {
      expect(true).toBe(true);
      return;
    }
    const dumpDir = resolve(
      __dirname,
      '../../../sidetrack-extension/tests/unit/connections/__fixtures__',
    );
    mkdirSync(dumpDir, { recursive: true });
    const wholeSnapshotPath = resolve(dumpDir, 'multiFlowSnapshot.json');
    writeFileSync(wholeSnapshotPath, `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
    const anchors = [
      { id: FLOW_NODES.A.workstream, file: 'subgraph_ws_security.json' },
      { id: FLOW_NODES.B.workstream, file: 'subgraph_ws_postgres.json' },
      { id: FLOW_NODES.C.workstream, file: 'subgraph_ws_sidetrack.json' },
      { id: CROSS_FLOW_NODES.hnPgMergeVisit, file: 'subgraph_hn_pgmerge.json' },
    ];
    for (const a of anchors) {
      const sub = subgraphForNode(snap, a.id, 2);
      const envelope = {
        scope: 'companion-extended',
        snapshot: sub,
      };
      writeFileSync(resolve(dumpDir, a.file), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    }
    expect(true).toBe(true);
  });

  it('determinism: byte-identical snapshots across event-order shuffles', () => {
    const fwd = JSON.stringify(buildConnectionsSnapshot(buildMultiFlowFixture()));
    const reversed = (() => {
      const input = buildMultiFlowFixture();
      return JSON.stringify(
        buildConnectionsSnapshot({ ...input, events: [...input.events].reverse() }),
      );
    })();
    const seededShuffle = (() => {
      const input = buildMultiFlowFixture();
      // Deterministic permutation: sort by clientEventId hash-ish.
      const shuffled = [...input.events].sort((a, b) =>
        a.clientEventId < b.clientEventId ? 1 : -1,
      );
      return JSON.stringify(buildConnectionsSnapshot({ ...input, events: shuffled }));
    })();
    expect(reversed).toBe(fwd);
    expect(seededShuffle).toBe(fwd);
  });
});
