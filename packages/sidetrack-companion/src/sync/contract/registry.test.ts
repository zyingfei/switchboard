import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CONTRACT_REGISTRY,
  KNOWN_MATERIALIZERS,
  REGISTERED_EVENT_TYPES,
} from './registry.js';

// Coverage assertions for the sync contract registry.
//
// The registry IS the documentation. These tests fail loudly if a new
// event type lands without a registry entry, if a materializer field
// references something we haven't wired, or if Class A/B/E surfaces
// drift from their required materializer routing.

const enumerateSourceEventTypes = async (): Promise<readonly string[]> => {
  // Walk *.events.ts files (one per aggregate) AND review/projection.ts
  // (which exports REVIEW_DRAFT_EVENT_TYPES inline). Extract the
  // string-literal RHS of `export const ... = '<type>' as const` plus
  // every literal in REVIEW_DRAFT_EVENT_TYPES.
  const root = join(fileURLToPath(new URL('../../', import.meta.url)));
  const eventFiles: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === 'events.ts') {
        eventFiles.push(full);
      }
      if (full.endsWith('review/projection.ts')) {
        eventFiles.push(full);
      }
    }
  };
  await walk(root);

  const types: string[] = [];
  for (const file of eventFiles) {
    const text = await readFile(file, 'utf8');
    // Match: export const FOO = 'foo.bar' as const;
    for (const match of text.matchAll(
      /export const \w+\s*=\s*['"]([\w.\-]+)['"]\s+as const/g,
    )) {
      types.push(match[1] ?? '');
    }
    // Match REVIEW_DRAFT_EVENT_TYPES = [ 'review-draft.x', ... ] as const;
    const rdMatch = text.match(
      /REVIEW_DRAFT_EVENT_TYPES\s*=\s*\[([\s\S]*?)\]\s*as const/,
    );
    if (rdMatch !== null) {
      for (const lit of (rdMatch[1] ?? '').matchAll(/'([\w.\-]+)'/g)) {
        types.push(lit[1] ?? '');
      }
    }
  }
  return types.filter((t) => t.length > 0);
};

describe('sync contract registry', () => {
  it('every event type referenced in src/**/events.ts (and review-draft list) has exactly one registry entry', async () => {
    const sourceTypes = new Set(await enumerateSourceEventTypes());
    const missing: string[] = [];
    for (const t of sourceTypes) {
      if (!REGISTERED_EVENT_TYPES.has(t)) {
        missing.push(t);
      }
    }
    expect(missing, `missing registry entries: ${missing.join(', ')}`).toEqual([]);

    // Inverse: every registry entry must correspond to a real event
    // type (no orphan rows). Walk CONTRACT_REGISTRY counts; collisions
    // and missing source types both surface.
    const counts = new Map<string, number>();
    for (const entry of CONTRACT_REGISTRY) {
      counts.set(entry.eventType, (counts.get(entry.eventType) ?? 0) + 1);
    }
    for (const [eventType, count] of counts) {
      expect(count, `eventType ${eventType} has ${count} registry entries`).toBe(1);
      expect(
        sourceTypes.has(eventType),
        `registry entry references unknown event type '${eventType}'`,
      ).toBe(true);
    }
  });

  it('every materializer field references a known materializer name', () => {
    const orphans: { eventType: string; materializer: string }[] = [];
    for (const entry of CONTRACT_REGISTRY) {
      for (const surface of entry.surfaces) {
        if (surface.materializer !== undefined && !KNOWN_MATERIALIZERS.has(surface.materializer)) {
          orphans.push({ eventType: entry.eventType, materializer: surface.materializer });
        }
      }
    }
    expect(orphans, `orphan materializer references: ${JSON.stringify(orphans)}`).toEqual([]);
  });

  it('every aggregate-projection surface routes to the projection materializer', () => {
    const wrong: { eventType: string; surface: string; materializer?: string }[] = [];
    for (const entry of CONTRACT_REGISTRY) {
      for (const surface of entry.surfaces) {
        if (
          surface.class === 'aggregate-projection' &&
          surface.surface !== 'annotation-overlay' &&
          surface.materializer !== 'projection'
        ) {
          wrong.push({
            eventType: entry.eventType,
            surface: surface.surface,
            ...(surface.materializer === undefined ? {} : { materializer: surface.materializer }),
          });
        }
      }
    }
    expect(wrong, `wrong materializer for class A: ${JSON.stringify(wrong)}`).toEqual([]);
  });

  it('every derived-cache surface has a valid recovery mode', () => {
    const wrong: { eventType: string; surface: string; recovery?: string }[] = [];
    const valid = new Set(['source-scoped-reextract', 'replay-event-log']);
    for (const entry of CONTRACT_REGISTRY) {
      for (const surface of entry.surfaces) {
        if (surface.class === 'derived-cache' && !valid.has(surface.recovery ?? '')) {
          wrong.push({
            eventType: entry.eventType,
            surface: surface.surface,
            ...(surface.recovery === undefined ? {} : { recovery: surface.recovery }),
          });
        }
      }
    }
    expect(wrong, `derived-cache without proper recovery: ${JSON.stringify(wrong)}`).toEqual([]);
  });

  it('every local-only surface has a localOnlyReason', () => {
    const wrong: { eventType: string; surface: string }[] = [];
    for (const entry of CONTRACT_REGISTRY) {
      for (const surface of entry.surfaces) {
        if (
          surface.class === 'local-only' &&
          (surface.localOnlyReason === undefined || surface.localOnlyReason.length === 0)
        ) {
          wrong.push({ eventType: entry.eventType, surface: surface.surface });
        }
      }
    }
    expect(wrong, `local-only without reason: ${JSON.stringify(wrong)}`).toEqual([]);
  });

  it('no entry has an empty surfaces[]', () => {
    const empty = CONTRACT_REGISTRY.filter((entry) => entry.surfaces.length === 0).map(
      (entry) => entry.eventType,
    );
    expect(empty, `entries with empty surfaces: ${empty.join(', ')}`).toEqual([]);
  });
});
