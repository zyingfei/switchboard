import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENTITY_ENRICHMENT_RETRACTED } from '../enrichment/events.js';
import {
  loadGistLookup,
  lookupGist,
  resetGistLookupMemoForTest,
} from '../enrichment/contentEnrichment.js';
import { TITLE_ENRICHMENT_ENV } from '../enrichment/titleEnrichment.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

// The end-to-end path the live purge actually took: POST a gist, POST a
// retraction, and assert the SERVED lookup — not just the event log — stops
// returning it. Asserting on the log alone would pass while the gist kept
// serving from a fold that never learned to read retractions, which is exactly
// the failure this route exists to prevent.

describe('POST /v1/enrichment/retract', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'enrichment-retract-bridge-key';

  beforeEach(async () => {
    resetGistLookupMemoForTest();
    delete process.env[TITLE_ENRICHMENT_ENV];
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-enrichment-retract-http-'));
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

  const post = async (
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${serverUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const URL_ID = 'https://news.ycombinator.com/item?id=49065752';
  const LOOP = "…\nIt's a long story.\n…\nIt's a long story.\n…\nIt's a long story.";

  const saveGist = async (over: Record<string, unknown> = {}): Promise<void> => {
    await post('/v1/enrichment/content', {
      items: [
        {
          kind: 'url',
          id: URL_ID,
          gist: LOOP,
          sourceContentHash: 'h1',
          model: 'gemma-3-1b-it',
          generatedAt: '2026-07-27T15:00:00.000Z',
          ...over,
        },
      ],
    });
    resetGistLookupMemoForTest();
  };

  const servedGist = async (): Promise<string | undefined> => {
    resetGistLookupMemoForTest();
    return lookupGist(await loadGistLookup(vaultRoot, eventLog), 'url', URL_ID);
  };

  const retractions = async (): Promise<readonly AcceptedEvent[]> =>
    (await eventLog.readMerged()).filter((e) => e.type === ENTITY_ENRICHMENT_RETRACTED);

  it('400s only for a non-object body / missing items array', async () => {
    expect((await post('/v1/enrichment/retract', { notItems: [] })).status).toBe(400);
  });

  it('stops a degenerate gist from SERVING, not just from the log', async () => {
    await saveGist();
    expect(await servedGist()).toBe(LOOP);

    const r = await post('/v1/enrichment/retract', {
      items: [
        { family: 'content', kind: 'url', id: URL_ID, reason: 'repetition loop' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.data.accepted).toBe(1);
    expect(await servedGist()).toBeUndefined();
  });

  it('is idempotent — re-running a purge accepts nothing the second time', async () => {
    await saveGist();
    const body = {
      items: [{ family: 'content', kind: 'url', id: URL_ID, reason: 'repetition loop' }],
    };
    expect((await post('/v1/enrichment/retract', body)).body.data.accepted).toBe(1);
    const second = await post('/v1/enrichment/retract', body);
    expect(second.body.data.accepted).toBe(0);
    expect(second.body.data.skipped).toBe(1);
    expect((await retractions()).length).toBe(1);
  });

  it('skips malformed items and counts them, never failing the batch', async () => {
    await saveGist();
    const r = await post('/v1/enrichment/retract', {
      items: [
        { family: 'content', kind: 'url', id: URL_ID, reason: 'repetition loop' },
        { family: 'summary', kind: 'url', id: URL_ID, reason: 'unknown family' },
        { family: 'content', kind: 'url', id: URL_ID },
        'not an object',
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.data.accepted).toBe(1);
    expect(r.body.data.skipped).toBe(3);
    expect(await servedGist()).toBeUndefined();
  });

  it('a hash-scoped retraction spares a gist that was re-synthesized meanwhile', async () => {
    await saveGist({ gist: 'A correct summary.', sourceContentHash: 'h2' });
    const r = await post('/v1/enrichment/retract', {
      items: [
        {
          family: 'content',
          kind: 'url',
          id: URL_ID,
          sourceContentHash: 'h1',
          reason: 'repetition loop in the h1 revision',
        },
      ],
    });
    expect(r.body.data.accepted).toBe(1);
    expect(await servedGist()).toBe('A correct summary.');
  });

  it('works with enrichment INGESTION switched off — cleanup must not need the feature on', async () => {
    await saveGist();
    process.env[TITLE_ENRICHMENT_ENV] = '0';
    const r = await post('/v1/enrichment/retract', {
      items: [{ family: 'content', kind: 'url', id: URL_ID, reason: 'repetition loop' }],
    });
    expect(r.body.data.accepted).toBe(1);
    delete process.env[TITLE_ENRICHMENT_ENV];
    expect(await servedGist()).toBeUndefined();
  });

  it('caps the batch at 50 items and counts the remainder as skipped', async () => {
    const items = Array.from({ length: 53 }, (_, i) => ({
      family: 'content',
      kind: 'url',
      id: `https://example.test/${String(i)}`,
      reason: 'bulk purge',
    }));
    const r = await post('/v1/enrichment/retract', { items });
    expect(r.body.data.accepted).toBe(50);
    expect(r.body.data.skipped).toBe(3);
  });

  it('stamps retractedAt server-side rather than trusting the caller', async () => {
    await saveGist();
    await post('/v1/enrichment/retract', {
      items: [
        {
          family: 'content',
          kind: 'url',
          id: URL_ID,
          reason: 'repetition loop',
          // A caller-supplied timestamp far in the past would, if honored,
          // silently fail to withdraw anything generated after it.
          retractedAt: '1999-01-01T00:00:00.000Z',
        },
      ],
    });
    const [event] = await retractions();
    const payload = event?.payload as { retractedAt: string };
    expect(payload.retractedAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(await servedGist()).toBeUndefined();
  });
});
