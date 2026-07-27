import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENTITY_TITLE_ENRICHED } from '../enrichment/events.js';
import {
  loadEnrichmentLookup,
  lookupSynthesizedTitle,
  resetEnrichmentLookupMemoForTest,
  TITLE_ENRICHMENT_ENV,
} from '../enrichment/titleEnrichment.js';
import { titleForCanonicalUrl } from '../attribution-v1/emit.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

describe('POST /v1/enrichment/titles', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'enrichment-bridge-key';

  beforeEach(async () => {
    resetEnrichmentLookupMemoForTest();
    delete process.env[TITLE_ENRICHMENT_ENV];
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-enrichment-http-'));
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
    resetEnrichmentLookupMemoForTest();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const post = async (body: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${serverUrl}/v1/enrichment/titles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: 'url',
    id: 'https://example.com/a',
    synthesizedTitle: 'A descriptive title',
    sourceContentHash: 'hash-a',
    model: 'gemini-nano',
    generatedAt: '2026-07-26T00:00:00.000Z',
    ...over,
  });

  it('400s only for a non-object body / missing items array', async () => {
    const r = await post({ notItems: [] });
    expect(r.status).toBe(400);
  });

  it('accepts valid items and appends one ENTITY_TITLE_ENRICHED event each', async () => {
    const r = await post({ items: [item(), item({ id: 'https://example.com/b', sourceContentHash: 'hash-b' })] });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ accepted: 2, skipped: 0 });
    const events = (await eventLog.readMerged()).filter((e) => e.type === ENTITY_TITLE_ENRICHED);
    expect(events).toHaveLength(2);
  });

  it('skips item-level problems (counted) without a 400', async () => {
    const r = await post({
      items: [
        item(), // valid
        item({ kind: 'bogus' }), // bad kind
        item({ synthesizedTitle: '' }), // empty title
        'not-an-object', // wrong shape
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ accepted: 1, skipped: 3 });
  });

  it('is idempotent per (kind,id,sourceContentHash): re-post is skipped', async () => {
    const first = await post({ items: [item()] });
    expect(first.body.data).toMatchObject({ accepted: 1, skipped: 0 });
    const second = await post({ items: [item()] });
    expect(second.body.data).toMatchObject({ accepted: 0, skipped: 1 });
    const events = (await eventLog.readMerged()).filter((e) => e.type === ENTITY_TITLE_ENRICHED);
    expect(events).toHaveLength(1);
  });

  it('a NEW hash for the same (kind,id) is accepted (supersedes)', async () => {
    await post({ items: [item()] });
    const r = await post({ items: [item({ sourceContentHash: 'hash-a2', synthesizedTitle: 'Newer' })] });
    expect(r.body.data).toMatchObject({ accepted: 1, skipped: 0 });
  });

  it('caps at 50 items/request, counting the excess as skipped', async () => {
    const many = Array.from({ length: 55 }, (_v, i) =>
      item({ id: `https://example.com/${String(i)}`, sourceContentHash: `h-${String(i)}` }),
    );
    const r = await post({ items: many });
    expect(r.body.data).toMatchObject({ accepted: 50, skipped: 5 });
  });

  it('flag off ⇒ 200 { accepted: 0, disabled: true } and appends nothing', async () => {
    process.env[TITLE_ENRICHMENT_ENV] = '0';
    const r = await post({ items: [item(), item({ id: 'x', sourceContentHash: 'h2' })] });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ accepted: 0, skipped: 2, disabled: true });
    const events = (await eventLog.readMerged()).filter((e) => e.type === ENTITY_TITLE_ENRICHED);
    expect(events).toHaveLength(0);
  });

  it('seam: titleForCanonicalUrl returns the synthesized title for a URL-shaped-label node once enrichment lands', async () => {
    const canonicalUrl = 'https://example.com/untitled';
    // A node whose only display label IS its URL — structurally junk. Without
    // enrichment, titleForCanonicalUrl returns undefined (URL is not a title).
    const snapshot = { nodes: [{ label: canonicalUrl, metadata: { canonicalUrl } }] };
    expect(titleForCanonicalUrl(snapshot, canonicalUrl)).toBeUndefined();

    // Land an enrichment for this URL via the route.
    const r = await post({
      items: [item({ id: canonicalUrl, synthesizedTitle: 'Untitled page, now titled', sourceContentHash: 'seam-h' })],
    });
    expect(r.body.data).toMatchObject({ accepted: 1 });

    // The folded lookup (memoized on the event-log signature) now carries the
    // synthesized title; passing it as the fallback surfaces it where the
    // node's label is URL-shaped junk.
    resetEnrichmentLookupMemoForTest();
    const lookup = await loadEnrichmentLookup(vaultRoot, eventLog);
    const synthesized = lookupSynthesizedTitle(lookup, 'url', canonicalUrl);
    expect(titleForCanonicalUrl(snapshot, canonicalUrl, synthesized)).toBe(
      'Untitled page, now titled',
    );

    // A REAL metadata title still wins over the synthesized one.
    const realSnapshot = {
      nodes: [{ label: canonicalUrl, metadata: { canonicalUrl, title: 'Real title' } }],
    };
    expect(titleForCanonicalUrl(realSnapshot, canonicalUrl, synthesized)).toBe('Real title');
  });
});
