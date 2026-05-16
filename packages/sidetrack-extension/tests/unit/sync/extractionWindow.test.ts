import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readActiveExtractionWindow,
  readActiveRevisionForSource,
  touchActiveRevision,
  upsertActiveExtractionRevision,
} from '../../../src/sync/extractionWindow';

// Lane 2 / L2-G9 — Mode P active extraction self-sufficiency.
//
// Plugin alone can render + locally search recent active
// extraction content. The active window stores FULL revision
// content (turns + roles + text), not just pointers. LRU eviction
// keeps it bounded; older revisions fall back to companion
// fetchExtended.

const stubChromeStorage = (): { reset: () => void } => {
  const store: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn((key: string) => Promise.resolve({ [key]: store[key] })),
        set: vi.fn((entries: Record<string, unknown>) => {
          Object.assign(store, entries);
          return Promise.resolve();
        }),
      },
    },
  };
  return {
    reset: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
};

const revisionInput = (sourceUnitId: string, text: string) => ({
  sourceUnitId,
  extractionRevisionId: `rev-${sourceUnitId}`,
  extractorId: 'legacy',
  extractorVersion: '0.0.0',
  content: {
    turns: [{ ordinal: 0, role: 'user' as const, text }],
    title: 'Active window probe',
    threadUrl: 'https://x',
    capturedAt: '2026-05-07T00:00:00.000Z',
  },
});

describe('plugin active extraction window', () => {
  let stub: ReturnType<typeof stubChromeStorage>;
  beforeEach(() => {
    stub = stubChromeStorage();
  });
  afterEach(() => {
    stub.reset();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('upsert + read round-trips full content (Mode P self-sufficient — text is on-device)', async () => {
    await upsertActiveExtractionRevision(revisionInput('src:A', 'hello mode P'), 100);
    const got = await readActiveRevisionForSource('src:A');
    expect(got).not.toBeNull();
    expect(got!.content.turns[0]?.text).toBe('hello mode P');
    expect(got!.lastSeenAt).toBeDefined();
  });

  it('upsert replaces prior revision for same sourceUnitId', async () => {
    await upsertActiveExtractionRevision(revisionInput('src:A', 'v1'), 100);
    await upsertActiveExtractionRevision(revisionInput('src:A', 'v2'), 100);
    const all = await readActiveExtractionWindow();
    expect(all).toHaveLength(1);
    expect(all[0]?.content.turns[0]?.text).toBe('v2');
  });

  it('LRU evicts oldest when budget exceeded', async () => {
    await upsertActiveExtractionRevision(revisionInput('src:A', 'a'), 2);
    await new Promise((r) => setTimeout(r, 5));
    await upsertActiveExtractionRevision(revisionInput('src:B', 'b'), 2);
    await new Promise((r) => setTimeout(r, 5));
    await upsertActiveExtractionRevision(revisionInput('src:C', 'c'), 2);
    const all = await readActiveExtractionWindow();
    expect(all).toHaveLength(2);
    const ids = all.map((r) => r.sourceUnitId).sort();
    expect(ids, 'A is oldest by lastSeenAt and gets evicted').toEqual(['src:B', 'src:C']);
  });

  it('touch refreshes lastSeenAt so LRU keeps recently-surfaced sources', async () => {
    await upsertActiveExtractionRevision(revisionInput('src:A', 'a'), 100);
    const beforeTouch = (await readActiveRevisionForSource('src:A'))?.lastSeenAt;
    await new Promise((r) => setTimeout(r, 10));
    await touchActiveRevision('src:A');
    const afterTouch = (await readActiveRevisionForSource('src:A'))?.lastSeenAt;
    expect(beforeTouch).toBeDefined();
    expect(afterTouch).toBeDefined();
    expect(afterTouch! > beforeTouch!).toBe(true);
  });

  it('readActiveRevisionForSource returns null for unknown source (caller falls back to companion fetchExtended)', async () => {
    const got = await readActiveRevisionForSource('src:NEVER_SEEN');
    expect(got).toBeNull();
  });
});
