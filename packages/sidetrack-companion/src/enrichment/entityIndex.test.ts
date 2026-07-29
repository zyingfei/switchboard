import { afterEach, describe, expect, it } from 'bun:test';

import type { AcceptedEvent } from '../sync/causal.js';
import { foldContentEnrichmentEvents, type GistLookup } from './contentEnrichment.js';
import {
  ENTITY_HUB_MAX_REFS,
  ENTITY_HUB_MIN_GISTS,
  ENTITY_INDEX_ENV,
  buildEntityIndex,
  listEntities,
  loadEntityIndex,
  lookupEntity,
  resetEntityIndexMemoForTest,
} from './entityIndex.js';
import { ENTITY_CONTENT_ENRICHED, ENTITY_ENRICHMENT_RETRACTED } from './events.js';

// The entity index is a PURE FOLD over the gist lookup, so these tests need no
// vault: they hand it a lookup and assert what comes out. The two properties
// worth defending are (1) refs count DOCUMENTS and join to where those
// documents are filed, and (2) hub damping — the review's explicit
// requirement that "AI" must not become a magnet.

const lookupOf = (entries: readonly (readonly [string, string])[]): GistLookup =>
  new Map(
    entries.map(([key, gist]) => [
      key,
      { gist, sourceContentHash: 'h', generatedAt: '2026-07-29T00:00:00.000Z' },
    ]),
  );

const gistNaming = (...entities: readonly string[]): string =>
  `A summary.\n\nKey Entities: ${entities.join(', ')}.`;

afterEach(() => {
  resetEntityIndexMemoForTest();
  delete process.env[ENTITY_INDEX_ENV];
});

describe('buildEntityIndex — refs and the workstream join', () => {
  it('counts DOCUMENTS, not mentions, and keeps the first display spelling', () => {
    const index = buildEntityIndex(
      lookupOf([
        ['url:https://a.test/1', 'Key Entities: OpenAI, OpenAI, Kimi Delta Attention.'],
        ['url:https://a.test/2', gistNaming('openai')],
      ]),
    );
    const entry = lookupEntity(index, 'OPENAI');
    expect(entry?.display).toBe('OpenAI');
    expect(entry?.refs.length).toBe(2);
    expect(index.gistCount).toBe(2);
    expect(index.scannedCount).toBe(2);
  });

  it('joins url refs to workstreams through the injected lookup, slash variants included', () => {
    const filed = new Map([
      ['https://a.test/1', 'WS_ALPHA'],
      // The projection spells this one WITH a trailing slash; the enrichment
      // id does not. Exact-key joins drift on that constantly.
      ['https://a.test/2/', 'WS_BETA'],
    ]);
    const index = buildEntityIndex(
      lookupOf([
        ['url:https://a.test/1', gistNaming('Kimi Delta Attention')],
        ['url:https://a.test/2', gistNaming('Kimi Delta Attention')],
        ['url:https://a.test/3', gistNaming('Kimi Delta Attention')],
      ]),
      { lookupWorkstreamByUrl: (url) => filed.get(url) },
    );
    const entry = lookupEntity(index, 'kimi delta attention');
    expect(entry?.workstreams).toEqual(['WS_ALPHA', 'WS_BETA']);
    // The unfiled page still contributes a ref — absent workstream is a fact,
    // not a reason to forget the page.
    expect(entry?.refs.length).toBe(3);
    expect(entry?.refs.filter((r) => r.workstreamId === undefined).length).toBe(1);
  });

  it('leaves thread refs unfiled unless a thread lookup is supplied', () => {
    const unjoined = buildEntityIndex(lookupOf([['thread:t1', gistNaming('Alpha')]]));
    expect(unjoined.byKey.get('alpha')?.refs).toEqual([{ kind: 'thread', id: 't1' }]);
    const joined = buildEntityIndex(lookupOf([['thread:t1', gistNaming('Alpha')]]), {
      lookupWorkstreamByThread: () => 'WS_T',
    });
    expect(joined.byKey.get('alpha')?.refs).toEqual([
      { kind: 'thread', id: 't1', workstreamId: 'WS_T' },
    ]);
  });

  it('skips a corrupt fold key rather than inventing an entity for it', () => {
    const index = buildEntityIndex(
      lookupOf([
        ['bogus:x', gistNaming('Alpha')],
        ['url:https://a.test/1', gistNaming('Beta')],
      ]),
    );
    expect([...index.byKey.keys()]).toEqual(['beta']);
    expect(index.scannedCount).toBe(2);
    expect(index.gistCount).toBe(1);
  });

  it('excludes entity-less gists from the hub denominator and reports coverage', () => {
    const index = buildEntityIndex(
      lookupOf([
        ['url:https://a.test/1', gistNaming('Alpha')],
        ['url:https://a.test/2', 'A summary with no entity section.'],
        ['url:https://a.test/3', 'Key Entities: None explicitly mentioned.'],
      ]),
    );
    expect(index.scannedCount).toBe(3);
    expect(index.gistCount).toBe(1);
  });

  it('sums the parser drops so a truncated list is visible, not silent', () => {
    const long = 'x'.repeat(100);
    const index = buildEntityIndex(
      lookupOf([['url:https://a.test/1', `Key Entities: Alpha, ${long}.`]]),
    );
    expect(index.droppedCandidates).toBe(1);
  });
});

describe('buildEntityIndex — hub damping', () => {
  const manyGists = (count: number, shared: string, sharedIn: number): GistLookup =>
    lookupOf(
      Array.from({ length: count }, (_, i) => {
        const own = `Unique${String(i)}`;
        return [
          `url:https://a.test/${String(i)}`,
          i < sharedIn ? gistNaming(shared, own) : gistNaming(own),
        ] as const;
      }),
    );

  it('marks an entity above the FRACTION threshold as a hub', () => {
    const index = buildEntityIndex(manyGists(10, 'AI', 3));
    expect(index.byKey.get('ai')?.hub).toBe(true);
    expect(index.hubCount).toBe(1);
  });

  it('leaves an entity below the fraction threshold alone', () => {
    const index = buildEntityIndex(manyGists(10, 'AI', 2));
    expect(index.byKey.get('ai')?.hub).toBe(false);
    expect(index.hubCount).toBe(0);
  });

  it('does not call anything a hub on a corpus below the sample floor', () => {
    // 3 of 4 gists = 75%, way over the fraction — but 4 gists is a small
    // sample, and damping there would hide the only entities that exist.
    expect(ENTITY_HUB_MIN_GISTS).toBeGreaterThan(4);
    const index = buildEntityIndex(manyGists(4, 'AI', 3));
    expect(index.byKey.get('ai')?.hub).toBe(false);
  });

  it('applies the ABSOLUTE rule even when the fraction is small', () => {
    const refs = ENTITY_HUB_MAX_REFS + 1;
    const index = buildEntityIndex(manyGists(200, 'AI', refs));
    // 31/200 is well under 25% — the absolute rule is what fires here.
    expect(refs / 200).toBeLessThan(0.25);
    expect(index.byKey.get('ai')?.hub).toBe(true);
  });

  it('excludes hubs from the listing but still answers an exact-name lookup', () => {
    const index = buildEntityIndex(manyGists(10, 'AI', 3));
    expect(listEntities(index).some((e) => e.name === 'AI')).toBe(false);
    const entry = lookupEntity(index, 'ai');
    expect(entry?.hub).toBe(true);
    expect(entry?.refs.length).toBe(3);
  });
});

describe('listEntities — ordering and cap', () => {
  it('sorts by refCount desc with a stable name tiebreak', () => {
    const index = buildEntityIndex(
      lookupOf([
        ['url:https://a.test/1', gistNaming('Beta', 'Alpha', 'zeta')],
        ['url:https://a.test/2', gistNaming('Beta')],
      ]),
    );
    expect(listEntities(index).map((e) => [e.name, e.refCount])).toEqual([
      ['Beta', 2],
      ['Alpha', 1],
      ['zeta', 1],
    ]);
  });

  it('honors the cap', () => {
    const index = buildEntityIndex(
      lookupOf([['url:https://a.test/1', gistNaming('Alpha', 'Beta', 'Gamma')]]),
    );
    expect(listEntities(index, 2).length).toBe(2);
    expect(listEntities(index, 0).length).toBe(0);
  });
});

describe('the fold inherits retraction handling for free', () => {
  let seq = 0;
  const evt = (type: string, payload: unknown): AcceptedEvent => {
    seq += 1;
    return {
      type,
      payload,
      clientEventId: `c${String(seq)}`,
      aggregateId: 'a',
      deps: {},
      acceptedAtMs: seq,
      dot: { replicaId: 'r1', seq },
    } as unknown as AcceptedEvent;
  };

  it('drops a retracted gist\'s entities with no retraction logic of its own', () => {
    const gist = evt(ENTITY_CONTENT_ENRICHED, {
      payloadVersion: 1,
      kind: 'url',
      id: 'https://a.test/1',
      gist: gistNaming('Kimi Delta Attention'),
      sourceContentHash: 'h1',
      model: 'gemma-3-1b-it',
      generatedAt: '2026-07-29T10:00:00.000Z',
    });
    const kept = evt(ENTITY_CONTENT_ENRICHED, {
      payloadVersion: 1,
      kind: 'url',
      id: 'https://a.test/2',
      gist: gistNaming('Hazard pointers'),
      sourceContentHash: 'h2',
      model: 'gemma-3-1b-it',
      generatedAt: '2026-07-29T10:00:00.000Z',
    });
    const retraction = evt(ENTITY_ENRICHMENT_RETRACTED, {
      payloadVersion: 1,
      family: 'content',
      kind: 'url',
      id: 'https://a.test/1',
      reason: 'repetition loop',
      retractedAt: '2026-07-29T11:00:00.000Z',
    });

    const before = buildEntityIndex(foldContentEnrichmentEvents([gist, kept]));
    expect(lookupEntity(before, 'Kimi Delta Attention')?.refs.length).toBe(1);

    const after = buildEntityIndex(foldContentEnrichmentEvents([gist, kept, retraction]));
    expect(lookupEntity(after, 'Kimi Delta Attention')).toBeUndefined();
    expect(lookupEntity(after, 'Hazard pointers')?.refs.length).toBe(1);
  });
});

describe('loadEntityIndex — typed absence', () => {
  it('returns a null index when the kill switch is off, without folding', async () => {
    process.env[ENTITY_INDEX_ENV] = '0';
    const loaded = await loadEntityIndex('/nonexistent-vault', undefined);
    expect(loaded.index).toBeNull();
    expect(loaded.signature).toBe('off');
  });

  it('returns a null index when there is no event log to derive from', async () => {
    const loaded = await loadEntityIndex('/nonexistent-vault', undefined);
    expect(loaded.index).toBeNull();
    expect(loaded.signature).toBe('none');
  });
});
