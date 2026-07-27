import { afterEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { ENTITY_TITLE_ENRICHED, isEntityTitleEnrichedPayload } from './events.js';
import {
  effectiveThreadTitle,
  effectiveTitle,
  effectiveUrlTitle,
  foldEnrichmentEvents,
  isJunkTitle,
  lookupSynthesizedTitle,
  titleEnrichmentEnabled,
  TITLE_ENRICHMENT_ENV,
} from './titleEnrichment.js';

let seq = 0;
const enrichEvent = (
  kind: 'thread' | 'url',
  id: string,
  synthesizedTitle: string,
  sourceContentHash: string,
): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `enrich-${seq}`,
    dot: { replicaId: 'r1', seq },
    deps: {},
    aggregateId: `enrichment:${kind}:${id}`,
    type: ENTITY_TITLE_ENRICHED,
    payload: {
      payloadVersion: 1,
      kind,
      id,
      synthesizedTitle,
      sourceContentHash,
      model: 'gemini-nano',
      generatedAt: '2026-07-26T00:00:00.000Z',
    },
    acceptedAtMs: seq,
  };
};

describe('title enrichment — payload guard', () => {
  const valid = {
    payloadVersion: 1,
    kind: 'thread',
    id: 'bac_123',
    synthesizedTitle: 'Debugging the resolver cache',
    sourceContentHash: 'deadbeef',
    model: 'gemini-nano',
    generatedAt: '2026-07-26T00:00:00.000Z',
  };

  it('accepts a well-formed payload', () => {
    expect(isEntityTitleEnrichedPayload(valid)).toBe(true);
  });

  it('rejects non-objects, wrong payloadVersion, and a dimensions channel', () => {
    expect(isEntityTitleEnrichedPayload(null)).toBe(false);
    expect(isEntityTitleEnrichedPayload('x')).toBe(false);
    expect(isEntityTitleEnrichedPayload({ ...valid, payloadVersion: 2 })).toBe(false);
    expect(isEntityTitleEnrichedPayload({ ...valid, dimensions: {} })).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(isEntityTitleEnrichedPayload({ ...valid, kind: 'workstream' })).toBe(false);
  });

  it('rejects empty / over-long strings on the load-bearing fields', () => {
    expect(isEntityTitleEnrichedPayload({ ...valid, id: '' })).toBe(false);
    expect(isEntityTitleEnrichedPayload({ ...valid, synthesizedTitle: '' })).toBe(false);
    expect(isEntityTitleEnrichedPayload({ ...valid, sourceContentHash: '' })).toBe(false);
    expect(isEntityTitleEnrichedPayload({ ...valid, synthesizedTitle: 'x'.repeat(201) })).toBe(
      false,
    );
    expect(isEntityTitleEnrichedPayload({ ...valid, sourceContentHash: 'a'.repeat(65) })).toBe(
      false,
    );
  });
});

describe('title enrichment — fold idempotency', () => {
  it('folds two events with the SAME hash into a single entry (idempotent)', () => {
    const lookup = foldEnrichmentEvents([
      enrichEvent('thread', 'bac_a', 'A title', 'hash-1'),
      enrichEvent('thread', 'bac_a', 'A title', 'hash-1'),
    ]);
    expect(lookup.size).toBe(1);
    expect(lookupSynthesizedTitle(lookup, 'thread', 'bac_a')).toBe('A title');
  });

  it('supersedes when the SAME (kind,id) arrives with a NEW hash', () => {
    const lookup = foldEnrichmentEvents([
      enrichEvent('thread', 'bac_a', 'Old title', 'hash-1'),
      enrichEvent('thread', 'bac_a', 'New title', 'hash-2'),
    ]);
    expect(lookup.size).toBe(1);
    expect(lookupSynthesizedTitle(lookup, 'thread', 'bac_a')).toBe('New title');
  });

  it('keeps thread and url kinds in separate keyspaces', () => {
    const lookup = foldEnrichmentEvents([
      enrichEvent('thread', 'same-id', 'Thread title', 'h1'),
      enrichEvent('url', 'same-id', 'Url title', 'h2'),
    ]);
    expect(lookupSynthesizedTitle(lookup, 'thread', 'same-id')).toBe('Thread title');
    expect(lookupSynthesizedTitle(lookup, 'url', 'same-id')).toBe('Url title');
  });

  it('skips non-enrichment and malformed events', () => {
    const bogus: AcceptedEvent = {
      clientEventId: 'x',
      dot: { replicaId: 'r1', seq: 999 },
      deps: {},
      aggregateId: 'x',
      type: ENTITY_TITLE_ENRICHED,
      payload: { payloadVersion: 1, kind: 'thread' }, // missing required fields
      acceptedAtMs: 1,
    };
    const other: AcceptedEvent = { ...bogus, type: 'some.other.event' };
    const lookup = foldEnrichmentEvents([bogus, other]);
    expect(lookup.size).toBe(0);
  });
});

describe('title enrichment — junk rule (effectiveTitle)', () => {
  it('treats empty/whitespace and URL-shaped raw titles as junk', () => {
    expect(isJunkTitle(undefined)).toBe(true);
    expect(isJunkTitle(null)).toBe(true);
    expect(isJunkTitle('')).toBe(true);
    expect(isJunkTitle('   ')).toBe(true);
    expect(isJunkTitle('https://example.com/foo')).toBe(true);
    expect(isJunkTitle('HTTP://EXAMPLE.COM')).toBe(true);
  });

  it('treats a real title (even "ChatGPT") as NON-junk — no vocabulary list', () => {
    expect(isJunkTitle('ChatGPT')).toBe(false);
    expect(isJunkTitle('Debugging the resolver')).toBe(false);
  });

  it('raw wins when it is a real title', () => {
    expect(effectiveTitle('Real page title', 'Synth title')).toBe('Real page title');
    expect(effectiveTitle('ChatGPT', 'Synth title')).toBe('ChatGPT');
  });

  it('synthesized fills an empty raw title', () => {
    expect(effectiveTitle('', 'Synth title')).toBe('Synth title');
    expect(effectiveTitle(undefined, 'Synth title')).toBe('Synth title');
  });

  it('synthesized fills a URL-shaped raw title', () => {
    expect(effectiveTitle('https://example.com/x', 'Synth title')).toBe('Synth title');
  });

  it('no synthesized ⇒ raw stays as-is (undefined stays undefined)', () => {
    expect(effectiveTitle(undefined, undefined)).toBeUndefined();
    expect(effectiveTitle('', undefined)).toBe('');
    expect(effectiveTitle('https://example.com/x', undefined)).toBe('https://example.com/x');
  });

  it('effectiveThreadTitle / effectiveUrlTitle apply the lookup + junk rule', () => {
    const lookup = foldEnrichmentEvents([
      enrichEvent('thread', 'bac_a', 'Synth thread', 'h1'),
      enrichEvent('url', 'https://x/y', 'Synth url', 'h2'),
    ]);
    // Junk raw ⇒ synthesized fills.
    expect(effectiveThreadTitle(lookup, 'bac_a', 'ChatGPT') === 'ChatGPT').toBe(true); // real wins
    expect(effectiveThreadTitle(lookup, 'bac_a', '')).toBe('Synth thread');
    expect(effectiveUrlTitle(lookup, 'https://x/y', 'https://x/y')).toBe('Synth url');
    // Null lookup (flag off) ⇒ raw behavior.
    expect(effectiveThreadTitle(null, 'bac_a', '')).toBe('');
  });
});

describe('title enrichment — flag', () => {
  afterEach(() => {
    delete process.env[TITLE_ENRICHMENT_ENV];
  });

  it('defaults ON; only 0/false disables', () => {
    delete process.env[TITLE_ENRICHMENT_ENV];
    expect(titleEnrichmentEnabled()).toBe(true);
    process.env[TITLE_ENRICHMENT_ENV] = '1';
    expect(titleEnrichmentEnabled()).toBe(true);
    process.env[TITLE_ENRICHMENT_ENV] = '0';
    expect(titleEnrichmentEnabled()).toBe(false);
    process.env[TITLE_ENRICHMENT_ENV] = 'false';
    expect(titleEnrichmentEnabled()).toBe(false);
  });
});
