import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENTITY_CONTENT_ENRICHED,
  ENTITY_TITLE_ENRICHED,
} from '../enrichment/events.js';
import {
  foldContentEnrichmentEvents,
  loadGistLookup,
  lookupGist,
  resetGistLookupMemoForTest,
} from '../enrichment/contentEnrichment.js';
import {
  enrichmentClientEventId,
  TITLE_ENRICHMENT_ENV,
} from '../enrichment/titleEnrichment.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

describe('POST /v1/enrichment/content', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'content-enrichment-bridge-key';

  beforeEach(async () => {
    resetGistLookupMemoForTest();
    delete process.env[TITLE_ENRICHMENT_ENV];
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-content-enrichment-http-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
    const server = createCompanionHttpServer({
      bridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      replica,
      eventLog,
    });
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;
  });

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    delete process.env[TITLE_ENRICHMENT_ENV];
    resetGistLookupMemoForTest();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const post = async (body: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${serverUrl}/v1/enrichment/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: 'thread',
    id: 'bac_thread_1',
    gist: 'A conversation about setting up AWS CloudTrail and IAM roles.',
    sourceContentHash: 'chash-a',
    model: 'gemma-3-1b',
    generatedAt: '2026-07-27T00:00:00.000Z',
    ...over,
  });

  const contentEvents = async (): Promise<readonly AcceptedEvent[]> =>
    (await eventLog.readMerged()).filter((e) => e.type === ENTITY_CONTENT_ENRICHED);

  it('400s only for a non-object body / missing items array', async () => {
    const r = await post({ notItems: [] });
    expect(r.status).toBe(400);
  });

  it('accepts valid items and appends one ENTITY_CONTENT_ENRICHED event each', async () => {
    const r = await post({
      items: [item(), item({ id: 'bac_thread_2', sourceContentHash: 'chash-b' })],
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ accepted: 2, skipped: 0 });
    expect(await contentEvents()).toHaveLength(2);
  });

  it('skips item-level problems (counted) without a 400', async () => {
    const r = await post({
      items: [
        item(), // valid
        item({ kind: 'bogus' }), // bad kind
        item({ gist: '' }), // empty gist
        'not-an-object', // wrong shape
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ accepted: 1, skipped: 3 });
  });

  it('rejects a gist over 2000 chars (counted as skipped)', async () => {
    const r = await post({ items: [item({ gist: 'x'.repeat(2001) })] });
    expect(r.body.data).toMatchObject({ accepted: 0, skipped: 1 });
    expect(await contentEvents()).toHaveLength(0);
  });

  it('is idempotent per (kind,id,sourceContentHash): re-post is skipped', async () => {
    const first = await post({ items: [item()] });
    expect(first.body.data).toMatchObject({ accepted: 1, skipped: 0 });
    const second = await post({ items: [item()] });
    expect(second.body.data).toMatchObject({ accepted: 0, skipped: 1 });
    expect(await contentEvents()).toHaveLength(1);
  });

  it('a NEW hash for the same (kind,id) is accepted (supersedes)', async () => {
    await post({ items: [item()] });
    const r = await post({ items: [item({ sourceContentHash: 'chash-a2', gist: 'Newer gist' })] });
    expect(r.body.data).toMatchObject({ accepted: 1, skipped: 0 });
  });

  it('caps at 50 items/request, counting the excess as skipped', async () => {
    const many = Array.from({ length: 55 }, (_v, i) =>
      item({ id: `bac_${String(i)}`, sourceContentHash: `ch-${String(i)}` }),
    );
    const r = await post({ items: many });
    expect(r.body.data).toMatchObject({ accepted: 50, skipped: 5 });
  });

  it('flag off ⇒ 200 { accepted: 0, disabled: true } and appends nothing', async () => {
    process.env[TITLE_ENRICHMENT_ENV] = '0';
    const r = await post({ items: [item(), item({ id: 'bac_2', sourceContentHash: 'h2' })] });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ accepted: 0, skipped: 2, disabled: true });
    expect(await contentEvents()).toHaveLength(0);
  });

  it('content and title events for the same triple do NOT collide (distinct clientEventIds)', async () => {
    // A title event and a content event with the SAME (kind,id,hash) must get
    // DIFFERENT clientEventIds so one is never wrongly deduped as the other.
    const kind = 'thread';
    const id = 'bac_collide';
    const hash = 'same-hash';
    const titleId = enrichmentClientEventId(kind, id, hash);
    const contentId = enrichmentClientEventId(kind, id, hash, 'content');
    expect(titleId).not.toBe(contentId);
    // Back-compat: the default family is 'title' (byte-identical with the
    // no-family call the title path used before the parameter existed).
    expect(enrichmentClientEventId(kind, id, hash)).toBe(
      enrichmentClientEventId(kind, id, hash, 'title'),
    );

    // Landing a content event does not block a title event for the same triple.
    await post({ items: [item({ id, sourceContentHash: hash })] });
    const titleR = await fetch(`${serverUrl}/v1/enrichment/titles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify({
        items: [
          {
            kind,
            id,
            synthesizedTitle: 'A title',
            sourceContentHash: hash,
            model: 'm',
            generatedAt: '2026-07-27T00:00:00.000Z',
          },
        ],
      }),
    });
    const titleBody: any = await titleR.json();
    expect(titleBody.data).toMatchObject({ accepted: 1, skipped: 0 });
    const merged = await eventLog.readMerged();
    expect(merged.filter((e) => e.type === ENTITY_CONTENT_ENRICHED)).toHaveLength(1);
    expect(merged.filter((e) => e.type === ENTITY_TITLE_ENRICHED)).toHaveLength(1);
  });

  it('gist becomes retrievable via the folded lookup after ingestion', async () => {
    await post({ items: [item()] });
    resetGistLookupMemoForTest();
    const lookup = await loadGistLookup(vaultRoot, eventLog);
    expect(lookupGist(lookup, 'thread', 'bac_thread_1')).toBe(
      'A conversation about setting up AWS CloudTrail and IAM roles.',
    );
    // A miss / wrong kind returns undefined (typed emptiness).
    expect(lookupGist(lookup, 'url', 'bac_thread_1')).toBeUndefined();
  });
});

describe('foldContentEnrichmentEvents', () => {
  const makeEvent = (payload: Record<string, unknown>): AcceptedEvent =>
    ({ type: ENTITY_CONTENT_ENRICHED, payload }) as unknown as AcceptedEvent;

  const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    payloadVersion: 1,
    kind: 'thread',
    id: 'bac_1',
    gist: 'gist one',
    sourceContentHash: 'h1',
    model: 'm',
    generatedAt: '2026-07-27T00:00:00.000Z',
    ...over,
  });

  it('folds valid content events into a kind:id → gist lookup', () => {
    const lookup = foldContentEnrichmentEvents([makeEvent(valid())]);
    expect(lookup.get('thread:bac_1')?.gist).toBe('gist one');
  });

  it('is idempotent per hash; a new hash supersedes', () => {
    const lookup = foldContentEnrichmentEvents([
      makeEvent(valid()),
      makeEvent(valid({ gist: 'ignored (same hash)' })),
      makeEvent(valid({ gist: 'newer', sourceContentHash: 'h2' })),
    ]);
    expect(lookup.get('thread:bac_1')?.gist).toBe('newer');
    expect(lookup.get('thread:bac_1')?.sourceContentHash).toBe('h2');
  });

  it('skips malformed / wrong-type events', () => {
    const lookup = foldContentEnrichmentEvents([
      makeEvent(valid({ gist: '' })), // guard fail
      makeEvent(valid({ kind: 'bogus' })), // bad kind
      { type: ENTITY_TITLE_ENRICHED, payload: valid() } as unknown as AcceptedEvent, // wrong type
    ]);
    expect(lookup.size).toBe(0);
  });

  it('keeps distinct kinds separate (no cross-kind collision)', () => {
    const lookup = foldContentEnrichmentEvents([
      makeEvent(valid({ kind: 'thread', id: 'x', gist: 'thread gist' })),
      makeEvent(valid({ kind: 'url', id: 'x', gist: 'url gist', sourceContentHash: 'h9' })),
    ]);
    expect(lookup.get('thread:x')?.gist).toBe('thread gist');
    expect(lookup.get('url:x')?.gist).toBe('url gist');
  });
});
