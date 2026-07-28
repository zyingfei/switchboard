import { describe, expect, it } from 'bun:test';

import { foldContentEnrichmentEvents } from './contentEnrichment.js';
import {
  ENTITY_CONTENT_ENRICHED,
  ENTITY_ENRICHMENT_RETRACTED,
  ENTITY_TITLE_ENRICHED,
  isEntityEnrichmentRetractedPayload,
} from './events.js';
import { retractionClientEventId } from './enrichmentRetraction.js';
import { foldEnrichmentEvents } from './titleEnrichment.js';
import type { AcceptedEvent } from '../sync/causal.js';

// WHY THIS FILE EXISTS. Five gists synthesized before the generation path was
// fixed were sitting in the live vault feeding retrieval — three repetition
// loops, one paraphrased prompt-echo, one led by nav boilerplate. A gist goes
// into the recall lexical index and the content lane's embed text, so a
// degenerate one is WORSE than no gist. The log is append-only, so withdrawing
// one means appending a retraction and having the folds honor it.
//
// The tests below pin the SEMANTICS, not the plumbing: what a retraction
// withdraws, what it must NOT withdraw, and the property that made me choose
// timestamp resolution over stream position — the typed store read returns
// `ORDER BY replica_id, seq`, so a retraction resolved by position could
// silently fail to apply depending on which replica sorted first.

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

const gistEvent = (
  id: string,
  gist: string,
  hash: string,
  generatedAt = '2026-07-27T15:00:00.000Z',
): AcceptedEvent =>
  evt(ENTITY_CONTENT_ENRICHED, {
    payloadVersion: 1,
    kind: 'url',
    id,
    gist,
    sourceContentHash: hash,
    model: 'gemma-3-1b-it',
    generatedAt,
  });

const titleEvent = (
  id: string,
  title: string,
  hash: string,
  generatedAt = '2026-07-27T15:00:00.000Z',
): AcceptedEvent =>
  evt(ENTITY_TITLE_ENRICHED, {
    payloadVersion: 1,
    kind: 'url',
    id,
    synthesizedTitle: title,
    sourceContentHash: hash,
    model: 'gemma-3-1b-it',
    generatedAt,
  });

const retraction = (
  family: 'title' | 'content',
  id: string,
  opts: { hash?: string; at?: string } = {},
): AcceptedEvent =>
  evt(ENTITY_ENRICHMENT_RETRACTED, {
    payloadVersion: 1,
    family,
    kind: 'url',
    id,
    ...(opts.hash === undefined ? {} : { sourceContentHash: opts.hash }),
    reason: 'degenerate generation (repetition loop)',
    retractedAt: opts.at ?? '2026-07-27T16:00:00.000Z',
  });

const URL = 'https://news.ycombinator.com/item?id=49065752';
const LOOP = "…\nIt's a long story.\n…\nIt's a long story.\n…\nIt's a long story.";

describe('enrichment retraction — content fold', () => {
  it('withdraws a gist so it stops serving', () => {
    const before = foldContentEnrichmentEvents([gistEvent(URL, LOOP, 'h1')]);
    expect(before.get(`url:${URL}`)?.gist).toBe(LOOP);

    const after = foldContentEnrichmentEvents([
      gistEvent(URL, LOOP, 'h1'),
      retraction('content', URL),
    ]);
    expect(after.has(`url:${URL}`)).toBe(false);
  });

  it('leaves every OTHER entity untouched', () => {
    const other = 'https://example.test/keep-me';
    const lookup = foldContentEnrichmentEvents([
      gistEvent(URL, LOOP, 'h1'),
      gistEvent(other, 'A genuinely useful summary of the page.', 'h2'),
      retraction('content', URL),
    ]);
    expect(lookup.has(`url:${URL}`)).toBe(false);
    expect(lookup.get(`url:${other}`)?.gist).toBe('A genuinely useful summary of the page.');
  });

  it('does not blacklist the entity — a LATER re-enrichment serves again', () => {
    // The whole point of retract-not-ban: re-running synthesis against a fixed
    // model must work. The new gist post-dates the retraction, so it stands.
    const lookup = foldContentEnrichmentEvents([
      gistEvent(URL, LOOP, 'h1', '2026-07-27T15:00:00.000Z'),
      retraction('content', URL, { at: '2026-07-27T16:00:00.000Z' }),
      gistEvent(URL, 'A correct summary, generated after the fix.', 'h2', '2026-07-27T17:00:00.000Z'),
    ]);
    expect(lookup.get(`url:${URL}`)?.gist).toBe('A correct summary, generated after the fix.');
  });

  it('a hash-scoped retraction withdraws ONLY that revision', () => {
    // The race this prevents: a purge script computed for hash h1 lands after
    // the panel already re-synthesized to h2. The retraction must not eat h2.
    const lookup = foldContentEnrichmentEvents([
      gistEvent(URL, 'fresh and good', 'h2'),
      retraction('content', URL, { hash: 'h1' }),
    ]);
    expect(lookup.get(`url:${URL}`)?.gist).toBe('fresh and good');
  });

  it('a hash-scoped retraction DOES withdraw the revision it names', () => {
    const lookup = foldContentEnrichmentEvents([
      gistEvent(URL, LOOP, 'h1'),
      retraction('content', URL, { hash: 'h1' }),
    ]);
    expect(lookup.has(`url:${URL}`)).toBe(false);
  });

  it('applies regardless of stream position — the store read is replica-major', () => {
    // The reason this fold resolves on timestamps rather than position. Both
    // orderings are legal outputs of `ORDER BY replica_id, seq`, and a
    // retraction that only worked in one of them would be a silent
    // half-applied delete.
    const enrich = gistEvent(URL, LOOP, 'h1', '2026-07-27T15:00:00.000Z');
    const retract = retraction('content', URL, { at: '2026-07-27T16:00:00.000Z' });
    expect(foldContentEnrichmentEvents([enrich, retract]).has(`url:${URL}`)).toBe(false);
    expect(foldContentEnrichmentEvents([retract, enrich]).has(`url:${URL}`)).toBe(false);
  });

  it('a title retraction is inert in the content fold', () => {
    const lookup = foldContentEnrichmentEvents([
      gistEvent(URL, LOOP, 'h1'),
      retraction('title', URL),
    ]);
    expect(lookup.get(`url:${URL}`)?.gist).toBe(LOOP);
  });

  it('a retraction for an entity with no enrichment is a no-op, not a crash', () => {
    const lookup = foldContentEnrichmentEvents([retraction('content', 'https://never.enriched/')]);
    expect(lookup.size).toBe(0);
  });

  it('ignores a malformed retraction payload rather than withdrawing blindly', () => {
    const lookup = foldContentEnrichmentEvents([
      gistEvent(URL, LOOP, 'h1'),
      // No reason ⇒ guard rejects ⇒ the gist must survive. A retraction that
      // fails validation must never take effect by accident.
      evt(ENTITY_ENRICHMENT_RETRACTED, {
        payloadVersion: 1,
        family: 'content',
        kind: 'url',
        id: URL,
        retractedAt: '2026-07-27T16:00:00.000Z',
      }),
    ]);
    expect(lookup.get(`url:${URL}`)?.gist).toBe(LOOP);
  });
});

describe('enrichment retraction — title fold (symmetry)', () => {
  it('withdraws a synthesized title', () => {
    const lookup = foldEnrichmentEvents([
      titleEvent(URL, 'A Synthesized Title', 'h1'),
      retraction('title', URL),
    ]);
    expect(lookup.has(`url:${URL}`)).toBe(false);
  });

  it('a content retraction is inert in the title fold', () => {
    const lookup = foldEnrichmentEvents([
      titleEvent(URL, 'A Synthesized Title', 'h1'),
      retraction('content', URL),
    ]);
    expect(lookup.get(`url:${URL}`)?.title).toBe('A Synthesized Title');
  });
});

describe('enrichment retraction — payload guard', () => {
  const valid = {
    payloadVersion: 1,
    family: 'content',
    kind: 'url',
    id: URL,
    reason: 'degenerate',
    retractedAt: '2026-07-27T16:00:00.000Z',
  };

  it('accepts a well-formed unscoped retraction', () => {
    expect(isEntityEnrichmentRetractedPayload(valid)).toBe(true);
  });

  it('accepts a hash-scoped retraction', () => {
    expect(isEntityEnrichmentRetractedPayload({ ...valid, sourceContentHash: 'abc' })).toBe(true);
  });

  it('rejects an unknown family, an unknown kind, and a missing reason', () => {
    expect(isEntityEnrichmentRetractedPayload({ ...valid, family: 'summary' })).toBe(false);
    expect(isEntityEnrichmentRetractedPayload({ ...valid, kind: 'workstream' })).toBe(false);
    expect(isEntityEnrichmentRetractedPayload({ ...valid, reason: '' })).toBe(false);
  });

  it('rejects an EXPLICIT empty sourceContentHash (a caller bug, not "unscoped")', () => {
    expect(isEntityEnrichmentRetractedPayload({ ...valid, sourceContentHash: '' })).toBe(false);
  });

  it('rejects a `dimensions` field and a wrong payloadVersion', () => {
    expect(isEntityEnrichmentRetractedPayload({ ...valid, dimensions: {} })).toBe(false);
    expect(isEntityEnrichmentRetractedPayload({ ...valid, payloadVersion: 2 })).toBe(false);
  });
});

describe('enrichment retraction — idempotency key', () => {
  it('is stable, so re-running a purge is a no-op', () => {
    expect(retractionClientEventId('content', 'url', URL, 'h1')).toBe(
      retractionClientEventId('content', 'url', URL, 'h1'),
    );
  });

  it('separates the scoped and unscoped forms — they are different statements', () => {
    expect(retractionClientEventId('content', 'url', URL, 'h1')).not.toBe(
      retractionClientEventId('content', 'url', URL, undefined),
    );
  });

  it('separates families, so retracting a title never dedupes against a gist', () => {
    expect(retractionClientEventId('content', 'url', URL, 'h1')).not.toBe(
      retractionClientEventId('title', 'url', URL, 'h1'),
    );
  });

  it('cannot be confused with the enrichment key it withdraws', () => {
    expect(retractionClientEventId('content', 'url', URL, 'h1').startsWith('retract-')).toBe(true);
  });
});
