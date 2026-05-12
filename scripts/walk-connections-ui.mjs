#!/usr/bin/env node
// Stage 5 polish — First-principles UX walkthrough. Simulates the
// Connections UI rendering against the persistent recorder vault.
// For each canonical anchor kind (workstream, thread, tab-session,
// visit-instance, topic), simulates clicking that anchor and walks
// every sub-mode (Linked / Orbital / Flow Path / Focus / Context
// Pack) to report what the user actually sees.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VAULT = process.env.SIDETRACK_VAULT_DIR ?? join(homedir(), '.sidetrack-vault');
const SNAPSHOT_PATH = join(VAULT, '_BAC', 'connections', 'current.json');
const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return undefined;
  }
};
const titleOf = (n) =>
  n.metadata?.title ??
  n.metadata?.latestTitle ??
  (Array.isArray(n.metadata?.representativeTitles) && n.metadata.representativeTitles[0]) ??
  n.label ??
  `(${n.kind})`;

// subgraphForNode (frontend mirror — depth-bounded BFS).
const subgraph = (anchorId, hops) => {
  const allEdges = snap.edges;
  const visited = new Set([anchorId]);
  let frontier = new Set([anchorId]);
  const keptEdges = new Map();
  for (let h = 0; h < hops; h += 1) {
    const next = new Set();
    for (const e of allEdges) {
      if (frontier.has(e.fromNodeId) && !visited.has(e.toNodeId)) {
        keptEdges.set(e.id, e);
        next.add(e.toNodeId);
      }
      if (frontier.has(e.toNodeId) && !visited.has(e.fromNodeId)) {
        keptEdges.set(e.id, e);
        next.add(e.fromNodeId);
      }
      if (visited.has(e.fromNodeId) && visited.has(e.toNodeId)) {
        keptEdges.set(e.id, e);
      }
    }
    for (const id of next) visited.add(id);
    frontier = next;
    if (frontier.size === 0) break;
  }
  const nodeById = new Map(snap.nodes.map((n) => [n.id, n]));
  const nodes = [...visited].map((id) => nodeById.get(id)).filter(Boolean);
  return { nodes, edges: [...keptEdges.values()] };
};

const groupByKind = (nodes) => {
  const groups = {};
  for (const n of nodes) (groups[n.kind] ??= []).push(n);
  return groups;
};

const deriveFlowVisits = (nodes) =>
  nodes.filter((n) => n.kind === 'timeline-visit');
const deriveTopics = (nodes) => nodes.filter((n) => n.kind === 'topic');

const walk = (label, anchorId, hops = 1) => {
  console.log('\n' + '='.repeat(72));
  console.log(`USER CLICKS: ${label}`);
  console.log(`Anchor: ${anchorId}`);
  console.log(`Hops: ${hops}`);
  console.log('='.repeat(72));

  const sub = subgraph(anchorId, hops);
  const anchor = sub.nodes.find((n) => n.id === anchorId);
  console.log(
    `→ /v1/connections/nodes/${encodeURIComponent(anchorId)}/neighbors?hops=${hops}`,
  );
  console.log(`   returns ${sub.nodes.length} nodes + ${sub.edges.length} edges`);

  if (anchor === undefined) {
    console.log('   ⚠ anchor node NOT FOUND in snapshot — fetch would return empty');
    return;
  }
  console.log(`   anchor: "${titleOf(anchor)}" [${anchor.kind}]`);

  // Linked
  const neighbors = sub.nodes.filter((n) => n.id !== anchorId);
  const groups = groupByKind(neighbors);
  console.log('\n[Linked mode] groups by kind:');
  for (const [k, list] of Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`   ${k}: ${list.length}`);
  }
  if (Object.keys(groups).length === 0) {
    console.log('   (none — empty Linked panel)');
  }

  // Orbital — would render N nodes in concentric rings
  console.log(`\n[Orbital mode] ${sub.nodes.length} nodes in SVG (${sub.edges.length} edges drawn)`);
  if (sub.nodes.length < 2) {
    console.log('   ⚠ <2 nodes — orbital looks like a lone dot');
  } else if (sub.nodes.length > 50) {
    console.log(`   ⚠ ${sub.nodes.length} nodes is dense — orbital chips overlap`);
  }

  // Flow Path — only timeline-visits
  const visits = deriveFlowVisits(sub.nodes);
  console.log(`\n[Flow Path mode] ${visits.length} timeline-visits`);
  if (visits.length === 0) {
    console.log('   ⚠ NO timeline-visits in scope — Flow Path is BLANK');
  } else {
    for (const v of visits.slice(0, 3)) {
      console.log(`   • ${titleOf(v)}  (${v.lastSeenAt ?? '—'})`);
    }
    if (visits.length > 3) console.log(`   …+${visits.length - 3} more`);
  }

  // Focus — only topics
  const topics = deriveTopics(sub.nodes);
  console.log(`\n[Focus mode] ${topics.length} topic clusters`);
  if (topics.length === 0) {
    console.log('   ⚠ NO topic clusters in scope — Focus is BLANK');
  } else {
    for (const t of topics.slice(0, 3)) {
      console.log(`   • ${titleOf(t)}  (${t.metadata.memberCount} members)`);
    }
  }

  // Context Pack — only renders for workstream anchors
  const isWorkstream = anchorId.startsWith('workstream:');
  if (isWorkstream) {
    console.log(`\n[Context Pack mode] workstream anchor — composer renders`);
  } else {
    console.log(`\n[Context Pack mode] ⚠ non-workstream anchor — composer falls back to anchor.replace(/^workstream:/, '')`);
    console.log(`   would receive workstreamId = "${anchorId}" — likely a no-data state`);
  }

  // Right-rail: clicking a neighbor calls /v1/connections/edges/{id}
  const sampleEdge = sub.edges[0];
  if (sampleEdge !== undefined) {
    console.log(`\n[ProvenanceCard on edge click] /v1/connections/edges/${encodeURIComponent(sampleEdge.id)}`);
    console.log(`   kind: ${sampleEdge.kind}  confidence: ${sampleEdge.confidence}`);
  }
};

console.log('# First-principles UX walkthrough — Connections side panel');
console.log(`Snapshot: ${SNAPSHOT_PATH}`);
console.log(`Total: ${snap.nodeCount} nodes / ${snap.edgeCount} edges`);

// Pick 5 representative anchors — one per common kind.
const workstream = snap.nodes.find((n) => n.kind === 'workstream' && n.metadata?.title === 'linux-security');
const thread = snap.nodes.find((n) => n.kind === 'thread' && n.metadata?.title === 'Chicago Visit Plan');
const tabSession = snap.nodes.find((n) => n.kind === 'tab-session' && n.metadata?.latestTitle?.includes('Copy Fail'));
const topic = snap.nodes.find((n) => n.kind === 'topic');
const visit = snap.nodes.find(
  (n) => n.kind === 'visit-instance' && n.metadata?.title?.includes('Hacker News'),
);

walk('workstream → linux-security', workstream.id, 1);
walk('workstream → linux-security (2 hops)', workstream.id, 2);
walk('thread → Chicago Visit Plan', thread.id, 1);
walk('tab-session → Copy Fail page', tabSession.id, 1);
walk('topic → first cluster', topic.id, 1);
walk('visit-instance → HN article', visit.id, 1);

// 7 — pick a workstream that has no children
const childlessWs = snap.nodes.find(
  (n) => n.kind === 'workstream' && n.metadata?.title === 'test',
);
walk('workstream → test (probably empty)', childlessWs.id, 1);

// 8 — empty-anchor case (what happens when user types junk)
walk('empty/junk anchor', 'thread:doesnotexist', 1);

// Time-range probe
console.log('\n' + '='.repeat(72));
console.log('TIME-RANGE PROBE');
console.log('='.repeat(72));
const dates = snap.nodes.map((n) => n.lastSeenAt ?? n.firstSeenAt).filter(Boolean).sort();
console.log(`Earliest lastSeenAt: ${dates[0]}`);
console.log(`Latest lastSeenAt:   ${dates[dates.length - 1]}`);
console.log(`Span: ${new Date(dates[dates.length - 1]) - new Date(dates[0])}ms`);
console.log(`Date-bearing nodes: ${dates.length}/${snap.nodeCount}`);
console.log('Companion routes do not accept since/until/before/after query params — no time filter API.');
console.log('Frontend has no date picker control.');
