#!/usr/bin/env bun
// Stage 5 polish — Connections UI evaluation. Reads the persistent
// vault snapshot (`~/.sidetrack-vault/_BAC/connections/current.json`),
// pulls 5 representative examples per node kind + edge kind, and
// reports what `formatEntityDisplay` would render for each. This
// is the dry-run before the recorder pass so we know which surfaces
// are useful vs which still leak raw ids or have empty metadata.
//
// Run: bun scripts/eval-connections-ui.mjs

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VAULT = process.env.SIDETRACK_VAULT_DIR ?? join(homedir(), '.sidetrack-vault');
const SNAPSHOT_PATH = join(VAULT, '_BAC', 'connections', 'current.json');

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));

// Mirror of `formatEntityDisplay` (just enough for this audit).
const hostOf = (url) => {
  if (typeof url !== 'string' || url.length === 0) return undefined;
  try {
    const h = new URL(url).host;
    return h.length > 0 ? h : undefined;
  } catch {
    return undefined;
  }
};
const safeStr = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);
const metaStr = (m, keys) => {
  for (const k of keys) {
    const v = safeStr(m?.[k]);
    if (v !== undefined) return v;
  }
  return undefined;
};
const ID_LIKE = [
  /^tses_[A-Z0-9]/i, /^bac_[A-Za-z0-9]/i, /^visit-instance:/i, /^timeline-visit:/i,
  /^tab-session:/i, /^workstream:/i, /^thread:/i, /^dispatch:/i, /^replica:/i,
  /^topic:/i, /^snippet:/i, /^coding-session:/i, /^annotation:/i,
  /^queue-item:/i, /^inbound-reminder:/i, /^template:/i,
  /^[0-9A-Z]{16,26}$/,
];
const isIdLike = (s) => typeof s === 'string' && s.length > 0 && ID_LIKE.some((r) => r.test(s));
const cleanLabel = (l) => {
  const t = safeStr(l);
  if (t === undefined) return undefined;
  return isIdLike(t) ? undefined : t;
};
const trimPrefix = (id, p) => (id.startsWith(p) ? id.slice(p.length) : id);

const format = (node) => {
  const m = node.metadata ?? {};
  const labelClean = cleanLabel(node.label);
  switch (node.kind) {
    case 'workstream': {
      const title = metaStr(m, ['title']);
      return { primary: title ?? labelClean ?? 'Unknown workstream', tooltip: trimPrefix(node.id, 'workstream:') };
    }
    case 'thread': {
      const title = metaStr(m, ['title']);
      const provider = metaStr(m, ['provider']);
      const primary = title ?? labelClean ?? (provider ? `${provider} thread` : '(untitled thread)');
      return { primary, secondary: provider, tooltip: metaStr(m, ['url', 'canonicalUrl']) };
    }
    case 'tab-session': {
      const t = metaStr(m, ['latestTitle']);
      const u = metaStr(m, ['latestUrl', 'canonicalUrl']);
      const h = hostOf(u);
      return { primary: t ?? labelClean ?? h ?? '(untracked tab)', secondary: h, tooltip: u };
    }
    case 'visit-instance':
    case 'timeline-visit': {
      const t = metaStr(m, ['title']);
      const u = metaStr(m, ['canonicalUrl', 'url']);
      const h = hostOf(u);
      return { primary: t ?? labelClean ?? h ?? '(visit)', secondary: h, tooltip: u };
    }
    case 'dispatch': {
      const t = metaStr(m, ['title']);
      const p = metaStr(m, ['provider']);
      return { primary: t ?? labelClean ?? (p ? `${p} dispatch` : '(dispatch)'), secondary: p };
    }
    case 'topic': {
      const titles = m['representativeTitles'];
      let primary = '(topic cluster)';
      if (Array.isArray(titles) && titles.length > 0) {
        const first = safeStr(titles[0]);
        if (first !== undefined) primary = first;
      }
      if (primary === '(topic cluster)' && labelClean !== undefined) primary = labelClean;
      const memberCount = m['memberCount'];
      return { primary, secondary: typeof memberCount === 'number' ? `${memberCount} members` : undefined };
    }
    case 'replica':
      return { primary: '(replica)', tooltip: trimPrefix(node.id, 'replica:') };
    case 'snippet':
    case 'annotation':
    case 'queue-item':
    case 'inbound-reminder':
    case 'template':
      return { primary: metaStr(m, ['title', 'text', 'note']) ?? labelClean ?? `(${node.kind})` };
    default:
      return { primary: labelClean ?? `(${node.kind})` };
  }
};

const sample = (arr, n) => arr.slice(0, Math.min(n, arr.length));

// Score: how useful would a user find this rendering?
//   5 — a human-readable title, ready to scan
//   4 — title + helpful secondary (host / provider / member count)
//   3 — usable but generic (e.g. host only, no title)
//   2 — only a kind placeholder ("(visit)", "(untitled thread)")
//   1 — raw id leaked into primary, or worse
const score = (display, node) => {
  if (isIdLike(display.primary)) return 1;
  if (display.primary.startsWith('(') && display.primary.endsWith(')')) {
    return display.secondary ? 3 : 2;
  }
  if (display.secondary) return 5;
  return 4;
};

console.log('# Connections UI evaluation against persistent recorder vault');
console.log('Snapshot:', SNAPSHOT_PATH);
console.log('updatedAt:', snapshot.updatedAt);
console.log('nodes:', snapshot.nodeCount, 'edges:', snapshot.edgeCount);
console.log();

const kinds = {};
for (const n of snapshot.nodes) (kinds[n.kind] ??= []).push(n);

for (const kind of Object.keys(kinds).sort()) {
  console.log(`## ${kind} (${kinds[kind].length} nodes)`);
  const examples = sample(kinds[kind], 5);
  for (const node of examples) {
    const display = format(node);
    const s = score(display, node);
    const metaKeys = Object.keys(node.metadata ?? {}).sort().join(', ');
    console.log(`  [${s}/5] primary: "${display.primary}"`);
    if (display.secondary) console.log(`         secondary: "${display.secondary}"`);
    if (display.tooltip) console.log(`         tooltip: ${display.tooltip.length > 60 ? display.tooltip.slice(0, 60) + '…' : display.tooltip}`);
    console.log(`         metadata keys: ${metaKeys || '(none)'}`);
    console.log(`         raw id: ${node.id.length > 50 ? node.id.slice(0, 50) + '…' : node.id}`);
    console.log();
  }
  console.log();
}

// Edge analysis
const edgeKinds = {};
for (const e of snapshot.edges) (edgeKinds[e.kind] ??= []).push(e);
console.log();
console.log('# Edges — sample 3 per kind with from→to labels');
console.log();

const nodeById = new Map();
for (const n of snapshot.nodes) nodeById.set(n.id, n);
const formatNodeIdDisplay = (id) => {
  const n = nodeById.get(id);
  if (n) return format(n);
  // Fallback: kind-from-prefix
  const colon = id.indexOf(':');
  const kind = colon === -1 ? 'node' : id.slice(0, colon);
  if (kind === 'workstream') return { primary: 'Unknown workstream' };
  if (kind === 'timeline-visit') {
    const url = id.slice(colon + 1);
    return { primary: hostOf(url) ?? '(visit)' };
  }
  if (kind === 'visit-instance') {
    const tail = id.slice(colon + 1);
    const httpIdx = tail.indexOf(':http');
    if (httpIdx >= 0) {
      const url = tail.slice(httpIdx + 1);
      return { primary: hostOf(url) ?? '(visit)' };
    }
    return { primary: '(visit)' };
  }
  return { primary: `(${kind})` };
};

for (const kind of Object.keys(edgeKinds).sort()) {
  console.log(`## ${kind} (${edgeKinds[kind].length} edges)`);
  const examples = sample(edgeKinds[kind], 3);
  for (const e of examples) {
    const fromD = formatNodeIdDisplay(e.fromNodeId);
    const toD = formatNodeIdDisplay(e.toNodeId);
    console.log(`  - "${fromD.primary}" → "${toD.primary}"  [${e.confidence}]`);
  }
  console.log();
}
