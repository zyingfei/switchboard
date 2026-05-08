import { describe, expect, it } from 'vitest';

import {
  REALISTIC_FLOW_A_NODES,
  REALISTIC_FLOW_B_NODES,
  buildRealisticFlowFixture,
} from './__fixtures__/realisticFlowStory.js';
import { buildConnectionsSnapshot, subgraphForNode } from './snapshot.js';

// Realistic-flow connection-report test.
//
// Doesn't assert specific edge counts — instead prints a connection
// report for each meaningful anchor (workstream / each timeline visit
// the user mentioned in their narration) so we can see what actually
// links and what stays orphaned. Useful when discussing whether the
// feature is "ready" for ambient-browsing scenarios.

const sortedSet = (set: ReadonlySet<string>): string[] => [...set].sort();

const reportFor = (
  label: string,
  snap: ReturnType<typeof buildConnectionsSnapshot>,
  anchorId: string,
  hops: number,
): { reachable: ReadonlySet<string>; lines: readonly string[] } => {
  const sub = subgraphForNode(snap, anchorId, hops);
  const reachable = new Set(sub.nodes.map((n) => n.id));
  const lines: string[] = [
    `--- ${label} (anchor=${anchorId}, hops=${String(hops)}) ---`,
    `  reachable nodes (${String(reachable.size)}): ${sortedSet(reachable).join(', ') || '<none>'}`,
    `  reachable edges (${String(sub.edges.length)}):`,
  ];
  for (const e of sub.edges) {
    lines.push(`    ${e.kind}: ${e.fromNodeId} → ${e.toNodeId}`);
  }
  return { reachable, lines };
};

describe('connections — realistic two-flow narration (CVE + Switchboard)', () => {
  const snap = buildConnectionsSnapshot(buildRealisticFlowFixture());

  it('prints a connection report so we can see what links per anchor', () => {
    const reports: string[] = [];
    reports.push(
      `\n=== realistic-flow snapshot ===`,
      `  total nodes: ${String(snap.nodeCount)}`,
      `  total edges: ${String(snap.edgeCount)}`,
      `  edge kinds present: ${sortedSet(new Set(snap.edges.map((e) => e.kind as string))).join(', ')}`,
      ``,
    );
    const { lines: l1 } = reportFor(
      'Flow A — workstream ws_realistic_cve',
      snap,
      REALISTIC_FLOW_A_NODES.workstream,
      2,
    );
    reports.push(...l1, '');
    const { lines: l2 } = reportFor(
      'Flow B — workstream ws_realistic_switchboard',
      snap,
      REALISTIC_FLOW_B_NODES.workstream,
      2,
    );
    reports.push(...l2, '');

    // Now anchor on each "ambient browsing" visit the user
    // mentioned. These are the visits most at risk of NOT linking
    // because the user didn't necessarily paste them into a chat.
    const ambient: ReadonlyArray<readonly [string, string]> = [
      ['Flow A — Google search', REALISTIC_FLOW_A_NODES.visits.googleSearch],
      ['Flow A — HN thread visit', REALISTIC_FLOW_A_NODES.visits.hn],
      ['Flow A — copy.fail homepage', REALISTIC_FLOW_A_NODES.visits.copyFail],
      ['Flow A — xint.io blog', REALISTIC_FLOW_A_NODES.visits.blog],
      ['Flow A — github PoC', REALISTIC_FLOW_A_NODES.visits.githubPoC],
      ['Flow B — switchboard repo', REALISTIC_FLOW_B_NODES.visits.repo],
      ['Flow B — switchboard PRs', REALISTIC_FLOW_B_NODES.visits.prs],
      ['Flow B — YouTube video', REALISTIC_FLOW_B_NODES.visits.youtube],
      ['Flow B — Gemini analysis', REALISTIC_FLOW_B_NODES.visits.gemini],
    ];
    for (const [label, anchor] of ambient) {
      const { lines } = reportFor(label, snap, anchor, 1);
      reports.push(...lines, '');
    }

    // eslint-disable-next-line no-console
    console.log(reports.join('\n'));
  });

  it('Flow A workstream anchor reaches its threads, dispatches, coding session', () => {
    const sub = subgraphForNode(snap, REALISTIC_FLOW_A_NODES.workstream, 2);
    const ids = new Set(sub.nodes.map((n) => n.id));
    for (const id of REALISTIC_FLOW_A_NODES.threads) expect(ids.has(id)).toBe(true);
    for (const id of REALISTIC_FLOW_A_NODES.dispatches) expect(ids.has(id)).toBe(true);
    for (const id of REALISTIC_FLOW_A_NODES.codingSessions) expect(ids.has(id)).toBe(true);
    for (const id of REALISTIC_FLOW_B_NODES.threads) expect(ids.has(id)).toBe(false);
  });

  it('Flow B workstream anchor reaches its threads only', () => {
    const sub = subgraphForNode(snap, REALISTIC_FLOW_B_NODES.workstream, 2);
    const ids = new Set(sub.nodes.map((n) => n.id));
    for (const id of REALISTIC_FLOW_B_NODES.threads) expect(ids.has(id)).toBe(true);
    for (const id of REALISTIC_FLOW_A_NODES.threads) expect(ids.has(id)).toBe(false);
  });

  it('Google search visit anchor surfaces zero connections (ambient gap)', () => {
    const sub = subgraphForNode(snap, REALISTIC_FLOW_A_NODES.visits.googleSearch, 1);
    // The anchor itself is included; everything else is empty since
    // the search URL was never pasted into a chat. This is the
    // "ambient browsing not connected" case.
    expect(sub.nodes.map((n) => n.id)).toEqual([REALISTIC_FLOW_A_NODES.visits.googleSearch]);
    expect(sub.edges.length).toBe(0);
  });

  it('YouTube visit anchor surfaces zero connections (ambient gap)', () => {
    const sub = subgraphForNode(snap, REALISTIC_FLOW_B_NODES.visits.youtube, 1);
    expect(sub.nodes.map((n) => n.id)).toEqual([REALISTIC_FLOW_B_NODES.visits.youtube]);
    expect(sub.edges.length).toBe(0);
  });

  it('HN visit anchor surfaces zero connections — until the user pastes it (which Flow A does)', () => {
    const sub = subgraphForNode(snap, REALISTIC_FLOW_A_NODES.visits.hn, 1);
    // ChatGPT thread DID paste the HN URL → thread_references_url
    // edge → 1-hop reaches the thread.
    const ids = new Set(sub.nodes.map((n) => n.id));
    expect(ids.has(REALISTIC_FLOW_A_NODES.visits.hn)).toBe(true);
    expect(ids.has(REALISTIC_FLOW_A_NODES.threads[0])).toBe(true);
  });
});
