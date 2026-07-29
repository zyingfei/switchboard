import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetGistLookupMemoForTest } from '../enrichment/contentEnrichment.js';
import { ENTITY_INDEX_ENV, resetEntityIndexMemoForTest } from '../enrichment/entityIndex.js';
import { TITLE_ENRICHMENT_ENV } from '../enrichment/titleEnrichment.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

// End-to-end for the entity layer: POST real gists through the SAME route the
// panel uses, then read the entity index back over HTTP. Asserting on the fold
// alone would pass while the routes served nothing — and the route is the only
// thing a user or an agent ever touches.

describe('GET /v1/entities', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'entities-route-bridge-key';

  const resetMemos = (): void => {
    resetGistLookupMemoForTest();
    resetEntityIndexMemoForTest();
  };

  beforeEach(async () => {
    resetMemos();
    delete process.env[TITLE_ENRICHMENT_ENV];
    delete process.env[ENTITY_INDEX_ENV];
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-entities-http-'));
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
    delete process.env[ENTITY_INDEX_ENV];
    resetMemos();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const post = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${serverUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const get = async (path: string): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${serverUrl}${path}`, {
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    return { status: response.status, body: await response.json() };
  };

  const saveGist = async (id: string, gist: string, hash: string): Promise<void> => {
    const r = await post('/v1/enrichment/content', {
      items: [
        {
          kind: 'url',
          id,
          gist,
          sourceContentHash: hash,
          model: 'apple-fm',
          generatedAt: '2026-07-29T10:00:00.000Z',
        },
      ],
    });
    expect(r.body.data.accepted).toBe(1);
    resetMemos();
  };

  const seed = async (): Promise<void> => {
    await saveGist(
      'https://a.test/supply-chain',
      'A disclosure story.\n\nKey Entities: JFrog, OpenAI, software supply chain attacks.',
      'h1',
    );
    await saveGist(
      'https://a.test/lockfree',
      '### Key Entities\n- People/Organizations: None explicitly mentioned.\n' +
        '- Technologies: Modern C++, hazard pointers.\n',
      'h2',
    );
    await saveGist(
      'https://a.test/openai-note',
      'Another note.\n\nKey Entities: OpenAI, evaluation harnesses.',
      'h3',
    );
  };

  it('lists entities derived from existing gists, ordered by refCount', async () => {
    await seed();
    const r = await get('/v1/entities');
    expect(r.status).toBe(200);
    const listed = r.body.data.entities as readonly { name: string; refCount: number }[];
    // OpenAI is named by two gists, everything else by one.
    expect(listed[0]?.name).toBe('OpenAI');
    expect(listed[0]?.refCount).toBe(2);
    expect(listed.map((e) => e.name)).toContain('Modern C++');
    expect(listed.map((e) => e.name)).toContain('hazard pointers');
    // The model's honest "None explicitly mentioned" is not an entity.
    expect(listed.map((e) => e.name.toLowerCase())).not.toContain('none explicitly mentioned');
    expect(r.body.data.gists).toBe(3);
    expect(r.body.data.scanned).toBe(3);
  });

  it('carries the kind bucket a labelled sublist put an entity under', async () => {
    await seed();
    const r = await get('/v1/entities');
    const cpp = (r.body.data.entities as readonly { name: string; kinds: string[] }[]).find(
      (e) => e.name === 'Modern C++',
    );
    expect(cpp?.kinds).toEqual(['tech']);
  });

  it('returns the dossier for a URL-encoded, case-insensitive name', async () => {
    await seed();
    const r = await get(`/v1/entities/${encodeURIComponent('modern c++')}`);
    expect(r.status).toBe(200);
    expect(r.body.data.entity.name).toBe('Modern C++');
    expect(r.body.data.entity.refCount).toBe(1);
    expect(r.body.data.entity.refs).toEqual([
      { kind: 'url', id: 'https://a.test/lockfree' },
    ]);
    expect(r.body.data.entity.hub).toBe(false);
  });

  it('404s with a typed problem for a name no gist mentions', async () => {
    await seed();
    const r = await get(`/v1/entities/${encodeURIComponent('Nonexistent Thing')}`);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('ENTITY_NOT_FOUND');
  });

  it('drops a retracted gist\'s entities from BOTH routes', async () => {
    await seed();
    expect((await get(`/v1/entities/${encodeURIComponent('JFrog')}`)).status).toBe(200);

    const retract = await post('/v1/enrichment/retract', {
      items: [
        {
          family: 'content',
          kind: 'url',
          id: 'https://a.test/supply-chain',
          reason: 'test purge',
        },
      ],
    });
    expect(retract.body.data.accepted).toBe(1);
    resetMemos();

    expect((await get(`/v1/entities/${encodeURIComponent('JFrog')}`)).status).toBe(404);
    const listed = (await get('/v1/entities')).body.data.entities as readonly { name: string }[];
    expect(listed.map((e) => e.name)).not.toContain('JFrog');
    // The surviving gists are untouched.
    expect(listed.map((e) => e.name)).toContain('Modern C++');
  });

  it('returns typed empty (never a 404) when the kill switch is off', async () => {
    await seed();
    process.env[ENTITY_INDEX_ENV] = '0';
    const list = await get('/v1/entities');
    expect(list.status).toBe(200);
    expect(list.body.data.entities).toEqual([]);
    expect(list.body.data.disabled).toBe(true);
    expect(typeof list.body.data.emptyReason).toBe('string');

    // "the feature is off" and "nothing named it" are different facts; the
    // detail route must not answer the first with a 404.
    const detail = await get(`/v1/entities/${encodeURIComponent('JFrog')}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.entity).toBeNull();
    expect(detail.body.data.disabled).toBe(true);
  });

  it('serves an empty index honestly on a vault with no gists at all', async () => {
    const r = await get('/v1/entities');
    expect(r.status).toBe(200);
    expect(r.body.data.entities).toEqual([]);
    expect(r.body.data.scanned).toBe(0);
    expect(r.body.data.disabled).toBeUndefined();
  });
});
