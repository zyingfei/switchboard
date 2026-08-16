import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import { createConnectionsStore } from '../connections/snapshot.js';
import type { ConnectionsSnapshot } from '../connections/types.js';
import { EMPTY_PROGRESS } from '../sync/contract/materializerProgress.js';
import type { GistLookup } from '../enrichment/contentEnrichment.js';
import {
  appleCanServe,
  detectContentLanguage,
  evidenceBudgetChars,
  gatherWorkstreamEvidence,
  selectEvidenceWithinBudget,
  workstreamEvidenceLanguage,
  ZH_DOMINANT_SHARE,
  type WorkstreamEvidenceItem,
} from './prototypeEvidence.js';

// ---- language detection (ported from nano/language.ts — byte-identical) --

describe('detectContentLanguage / appleCanServe', () => {
  it('classifies pure english as en, and en is the only language Apple FM may serve', () => {
    expect(detectContentLanguage('A deep dive into KV-cache compression for inference.')).toBe(
      'en',
    );
    expect(appleCanServe('en')).toBe(true);
  });

  it('classifies pure chinese as zh, above the dominant share', () => {
    const zh = '这是一篇关于机器学习模型训练与优化方法的详细文章讨论了梯度下降与正则化技术';
    expect(detectContentLanguage(zh)).toBe('zh');
    expect(appleCanServe('zh')).toBe(false);
  });

  it('classifies a mixed passage as mixed-en-zh, and Apple FM may not serve it either', () => {
    const mixed =
      'This is mostly English commentary but references 深度学习 and 神经网络 and 强化学习 ' +
      'terminology throughout the passage in a load-bearing way, not incidentally.';
    expect(detectContentLanguage(mixed)).toBe('mixed-en-zh');
    expect(appleCanServe('mixed-en-zh')).toBe(false);
  });

  it('a handful of incidental Han characters does not tip an English page into zh/mixed', () => {
    const mostlyEnglish =
      'A product named 京东 was mentioned once in this otherwise entirely English article ' +
      'about supply chain logistics and inventory management systems used by large retailers.';
    expect(detectContentLanguage(mostlyEnglish)).toBe('en');
  });

  it(`ZH_DOMINANT_SHARE is ${String(ZH_DOMINANT_SHARE)} (matches the extension's routing contract)`, () => {
    expect(ZH_DOMINANT_SHARE).toBe(0.6);
  });
});

// ---- evidence budgeting ---------------------------------------------------

const item = (
  canonicalUrl: string,
  opts: { readonly title?: string; readonly gist?: string; readonly atMs?: number },
): WorkstreamEvidenceItem => ({
  canonicalUrl,
  title: opts.title ?? null,
  gist: opts.gist ?? null,
  firstSeenAtMs: opts.atMs ?? 0,
});

describe('selectEvidenceWithinBudget', () => {
  it('selects most-recent-first and stops before exceeding the char budget', () => {
    const items = [
      item('https://a.test/1', { gist: 'AAAAAAAAAA', atMs: 1 }), // 10 chars
      item('https://a.test/2', { gist: 'BBBBBBBBBB', atMs: 3 }), // 10 chars, most recent
      item('https://a.test/3', { gist: 'CCCCCCCCCC', atMs: 2 }), // 10 chars
    ];
    const { selected, text } = selectEvidenceWithinBudget(items, 22); // room for exactly 2 excerpts (10+1+10=21)
    expect(selected.map((s) => s.canonicalUrl)).toEqual(['https://a.test/2', 'https://a.test/3']);
    expect(text).toBe('BBBBBBBBBB\nCCCCCCCCCC');
  });

  it('never truncates mid-excerpt — an over-budget excerpt is skipped, not cut, UNLESS it is the only one', () => {
    const items = [item('https://a.test/1', { gist: 'A'.repeat(50) })];
    const { selected, text } = selectEvidenceWithinBudget(items, 10);
    // Cold-start guard: zero evidence would be worse than one truncated item.
    expect(selected).toHaveLength(1);
    expect(text).toHaveLength(10);
  });

  it('skips items with no title/gist entirely', () => {
    const items = [
      item('https://a.test/1', {}),
      item('https://a.test/2', { title: 'has a title' }),
    ];
    const { selected } = selectEvidenceWithinBudget(items, 1000);
    expect(selected.map((s) => s.canonicalUrl)).toEqual(['https://a.test/2']);
  });
});

describe('evidenceBudgetChars', () => {
  it('is capped by the engine input limit even when the token budget would allow more', () => {
    expect(evidenceBudgetChars(100)).toBe(100);
    expect(evidenceBudgetChars(100_000)).toBe(900 * 4); // TARGET_CHUNK_TOKENS * CHARS_PER_TOKEN.en
  });
});

describe('workstreamEvidenceLanguage', () => {
  it('detects the corpus language from the most recent evidence excerpts', () => {
    const items = [
      item('https://a.test/1', { gist: 'An English sentence about model training.', atMs: 1 }),
    ];
    expect(workstreamEvidenceLanguage(items)).toBe('en');
  });
});

// ---- gatherWorkstreamEvidence (integration — real SqliteConnectionsStore) --

const progressFor = (snapshot: ConnectionsSnapshot) => ({
  ...EMPTY_PROGRESS('connections', 'connections@test'),
  appliedDotIntervals: { replica: [[1, 1] as const] },
  appliedFrontier: { replica: 1 },
  snapshotRevisionId: snapshot.snapshotRevision ?? null,
});

describe('gatherWorkstreamEvidence — groups filed evidence by workstream', () => {
  let vaultRoot: string;

  afterEach(async () => {
    if (vaultRoot.length > 0) await rm(vaultRoot, { recursive: true, force: true });
  });

  it('groups by currentAttribution.workstreamId, joining the gist when one exists', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-prototype-evidence-'));
    const store = createConnectionsStore(vaultRoot);
    const snapshot: ConnectionsSnapshot = {
      scope: {},
      nodes: [],
      edges: [],
      updatedAt: '2026-08-16T00:00:00.000Z',
      nodeCount: 0,
      edgeCount: 0,
      snapshotRevision: 'rev-evidence-1',
      urlProjection: {
        schemaVersion: 1,
        byCanonicalUrl: {
          'https://a.test/1': {
            canonicalUrl: 'https://a.test/1',
            firstSeenAt: '2026-08-01T00:00:00.000Z',
            lastSeenAt: '2026-08-01T00:00:00.000Z',
            latestTitle: 'KV-cache compression notes',
            visitCount: 1,
            tabSessionIds: [],
            currentAttribution: {
              workstreamId: 'ws-kv-cache',
              source: 'user_asserted',
              observedAt: '2026-08-01T00:00:00.000Z',
              clientEventId: 'evt-1',
              replicaId: 'r1',
              seq: 1,
            },
            attributionHistory: [],
          },
          'https://a.test/2': {
            canonicalUrl: 'https://a.test/2',
            firstSeenAt: '2026-08-02T00:00:00.000Z',
            lastSeenAt: '2026-08-02T00:00:00.000Z',
            latestTitle: 'Speculative decoding',
            visitCount: 1,
            tabSessionIds: [],
            currentAttribution: {
              workstreamId: 'ws-kv-cache',
              source: 'inferred',
              observedAt: '2026-08-02T00:00:00.000Z',
              clientEventId: 'evt-2',
              replicaId: 'r1',
              seq: 2,
            },
            attributionHistory: [],
          },
          'https://a.test/3': {
            canonicalUrl: 'https://a.test/3',
            firstSeenAt: '2026-08-03T00:00:00.000Z',
            lastSeenAt: '2026-08-03T00:00:00.000Z',
            visitCount: 1,
            tabSessionIds: [],
            // No currentAttribution — an inbox item, not evidence for anything.
            attributionHistory: [],
          },
        },
      },
    };
    await store.writeSnapshotAndProgress(snapshot, progressFor(snapshot));

    const gistLookup: GistLookup = new Map([
      [
        'url:https://a.test/1',
        {
          gist: 'A paragraph-scale gist about KV-cache compression.',
          sourceContentHash: 'h1',
          generatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    ]);

    const evidence = await gatherWorkstreamEvidence(store, gistLookup);
    expect([...evidence.keys()]).toEqual(['ws-kv-cache']);
    const items = evidence.get('ws-kv-cache') ?? [];
    expect(items).toHaveLength(2);
    const byUrl = new Map(items.map((i) => [i.canonicalUrl, i]));
    expect(byUrl.get('https://a.test/1')?.gist).toBe(
      'A paragraph-scale gist about KV-cache compression.',
    );
    expect(byUrl.get('https://a.test/2')?.gist).toBeNull();
    expect(byUrl.get('https://a.test/2')?.title).toBe('Speculative decoding');
  });

  it('returns an empty map (never throws) when the snapshot has no urlProjection yet', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-prototype-evidence-empty-'));
    const store = createConnectionsStore(vaultRoot);
    const evidence = await gatherWorkstreamEvidence(store, null);
    expect(evidence.size).toBe(0);
  });
});
