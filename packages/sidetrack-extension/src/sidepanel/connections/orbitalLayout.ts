import { EDGE_KINDS, type EdgeFamily } from './edgeKinds';
import type { ConnectionEdge, ConnectionsSnapshot } from './types';

// Orbital evidence graph (Concept B) — deterministic radial layout.
//
// Anchor at center; first-hop neighbors live on an inner ring,
// second-hop neighbors on an outer ring. Neighbors are bucketed
// into 4 angular sectors by edge family, so the same scenario
// always produces the same picture across replays:
//
//   contain  → top   (270° / -90°)
//   flow     → right (0°)
//   defer    → bottom (90°)
//   urlmatch → left  (180°)
//
// Pure function: same snapshot + same anchorId → byte-identical
// position table. Edge ordering inside each sector is sorted by
// (kind, otherEndId) so layout doesn't drift between runs.

export interface OrbitalNodePosition {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly ring: 0 | 1 | 2; // 0 = anchor, 1 = first-hop, 2 = second-hop
  readonly family: EdgeFamily | null; // null for anchor
}

export interface OrbitalLayoutResult {
  readonly width: number;
  readonly height: number;
  readonly center: { readonly x: number; readonly y: number };
  readonly r1: number;
  readonly r2: number;
  readonly positions: ReadonlyMap<string, OrbitalNodePosition>;
  // Edges actually shown (both endpoints are positioned).
  readonly edges: readonly ConnectionEdge[];
}

interface SectorSpec {
  readonly center: number; // degrees
  readonly span: number; // degrees
}

const SECTORS: Record<EdgeFamily, SectorSpec> = {
  contain: { center: -90, span: 100 },
  flow: { center: 0, span: 60 },
  defer: { center: 90, span: 100 },
  urlmatch: { center: 180, span: 80 },
};

const familyForEdge = (kind: string): EdgeFamily =>
  EDGE_KINDS[kind]?.family ?? 'urlmatch';

const cmpOtherEnd = (
  a: { kind: string; otherEnd: string },
  b: { kind: string; otherEnd: string },
): number => {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.otherEnd < b.otherEnd ? -1 : a.otherEnd > b.otherEnd ? 1 : 0;
};

export const computeOrbitalLayout = (input: {
  snapshot: ConnectionsSnapshot;
  anchorId: string;
  width: number;
  height: number;
  hops?: number;
}): OrbitalLayoutResult => {
  const { snapshot, anchorId, width, height } = input;
  const hops = input.hops === undefined ? 1 : Math.max(1, Math.min(2, input.hops));
  const cx = width / 2;
  const cy = height / 2;
  const minDim = Math.min(width, height);
  const r1 = minDim * 0.32;
  const r2 = minDim * 0.46;

  const positions = new Map<string, OrbitalNodePosition>();
  positions.set(anchorId, { id: anchorId, x: cx, y: cy, ring: 0, family: null });

  // Bucket every edge that touches the anchor by family. Sort each
  // bucket deterministically so node placement is stable.
  const firstHopEdges: Array<{ edge: ConnectionEdge; otherEnd: string; family: EdgeFamily }> = [];
  for (const edge of snapshot.edges) {
    if (edge.fromNodeId !== anchorId && edge.toNodeId !== anchorId) continue;
    const otherEnd = edge.fromNodeId === anchorId ? edge.toNodeId : edge.fromNodeId;
    if (otherEnd === anchorId) continue;
    firstHopEdges.push({ edge, otherEnd, family: familyForEdge(edge.kind) });
  }

  const byFamily = new Map<EdgeFamily, Array<{ edge: ConnectionEdge; otherEnd: string }>>();
  for (const item of firstHopEdges) {
    if (!byFamily.has(item.family)) byFamily.set(item.family, []);
    byFamily.get(item.family)!.push({ edge: item.edge, otherEnd: item.otherEnd });
  }
  for (const list of byFamily.values()) {
    list.sort((a, b) =>
      cmpOtherEnd(
        { kind: a.edge.kind, otherEnd: a.otherEnd },
        { kind: b.edge.kind, otherEnd: b.otherEnd },
      ),
    );
  }

  // Place first-hop neighbors evenly across each family sector.
  for (const family of Object.keys(SECTORS) as EdgeFamily[]) {
    const items = byFamily.get(family);
    if (items === undefined || items.length === 0) continue;
    const sec = SECTORS[family];
    const start = sec.center - sec.span / 2;
    const step = items.length === 1 ? 0 : sec.span / (items.length - 1);
    items.forEach((it, i) => {
      const deg = items.length === 1 ? sec.center : start + step * i;
      const rad = (deg * Math.PI) / 180;
      if (positions.has(it.otherEnd)) return;
      positions.set(it.otherEnd, {
        id: it.otherEnd,
        x: cx + Math.cos(rad) * r1,
        y: cy + Math.sin(rad) * r1,
        ring: 1,
        family,
      });
    });
  }

  // Optional second-hop placement: edges between two non-anchor
  // nodes where one endpoint is already on the inner ring.
  if (hops >= 2) {
    const secondHopCandidates: Array<{ edge: ConnectionEdge; otherEnd: string; family: EdgeFamily }> = [];
    for (const edge of snapshot.edges) {
      if (edge.fromNodeId === anchorId || edge.toNodeId === anchorId) continue;
      const fromOnRing = positions.has(edge.fromNodeId);
      const toOnRing = positions.has(edge.toNodeId);
      if (!fromOnRing && !toOnRing) continue;
      const otherEnd = fromOnRing ? edge.toNodeId : edge.fromNodeId;
      if (positions.has(otherEnd)) continue;
      secondHopCandidates.push({ edge, otherEnd, family: familyForEdge(edge.kind) });
    }
    secondHopCandidates.sort((a, b) =>
      cmpOtherEnd(
        { kind: a.edge.kind, otherEnd: a.otherEnd },
        { kind: b.edge.kind, otherEnd: b.otherEnd },
      ),
    );
    let i = 0;
    for (const c of secondHopCandidates) {
      const sec = SECTORS[c.family];
      const offset = i % 2 === 0 ? -20 : 20;
      const deg = sec.center + offset;
      const rad = (deg * Math.PI) / 180;
      positions.set(c.otherEnd, {
        id: c.otherEnd,
        x: cx + Math.cos(rad) * r2,
        y: cy + Math.sin(rad) * r2,
        ring: 2,
        family: c.family,
      });
      i += 1;
    }
  }

  // Filter snapshot edges to those whose endpoints are both placed.
  const visibleEdges = snapshot.edges.filter(
    (e) => positions.has(e.fromNodeId) && positions.has(e.toNodeId),
  );

  return {
    width,
    height,
    center: { x: cx, y: cy },
    r1,
    r2,
    positions,
    edges: visibleEdges,
  };
};
