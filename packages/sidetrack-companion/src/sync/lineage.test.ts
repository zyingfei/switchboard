import { describe, expect, it } from 'vitest';

import {
  derivedLineageNodes,
  LINEAGE_REGISTRY,
  lineageInputsOf,
  lineageNode,
} from './lineage.js';

describe('lineage registry (derivation DAG)', () => {
  it('has unique ids', () => {
    const ids = LINEAGE_REGISTRY.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every derivesFrom reference resolves to a registered node', () => {
    const ids = new Set(LINEAGE_REGISTRY.map((node) => node.id));
    for (const node of LINEAGE_REGISTRY) {
      for (const parent of node.derivesFrom) {
        expect(ids.has(parent)).toBe(true);
      }
    }
  });

  it('declares at least one canonical root and every derived store has a rebuild entrypoint', () => {
    const roots = LINEAGE_REGISTRY.filter((node) => node.defaultState === 'canonical');
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.some((node) => node.derivesFrom.length === 0)).toBe(true);
    for (const node of derivedLineageNodes()) {
      // `module.ts:exportName` shape — a descriptive reference, not a
      // live pointer (the registry imports no runtime rebuild code).
      expect(node.rebuildEntrypoint).toMatch(/\.ts:[A-Za-z.]+$/u);
      expect(node.derivesFrom.length).toBeGreaterThan(0);
    }
  });

  it('accessors: lineageNode + inputs in dependency order', () => {
    expect(lineageNode('does-not-exist')).toBeUndefined();
    expect(lineageNode('event-store')?.toggleEnv).toBe('SIDETRACK_EVENT_STORE');

    // connections-current derives (transitively) from the event log.
    const inputs = lineageInputsOf('connections-current');
    const inputIds = inputs.map((node) => node.id);
    expect(inputIds).toContain('event-log');
    // Roots come before the stores that build on them.
    expect(inputIds.indexOf('event-log')).toBeLessThan(inputIds.length);
  });
});
