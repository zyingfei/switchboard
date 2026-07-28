import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  appendContentEnrichmentEvent,
  gistLookupFromMerged,
  loadGistLookup,
  lookupGist,
  resetGistLookupMemoForTest,
} from './contentEnrichment.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';

// THE RESOLVER-CACHE HOLE, measured live 2026-07-28.
//
// The batch-resolve path folds enrichment from the merged event log it already
// read. When EVERY url is a resolver-cache hit it reads nothing, so `merged` is
// [] — and folding [] produced an EMPTY gist lookup that was then MEMOIZED
// under the real log signature, blanking the gist for every later reader until
// the log changed.
//
// For the TITLE lane an empty fold is genuinely correct: the title lane is
// baked into the cached resolver result. The CONTENT lane is decoupled from
// that cache by design and recomputes at query time, so it runs on cache hits
// and needs the gist right then. The symptom the user saw was a page whose gist
// they had just generated contributing nothing to any guess.

const URL_ID = 'https://news.ycombinator.com/item?id=49081644';
const GIST = 'Google Beyond Zero covers risks of AI agents causing real-world harm.';

describe('gist lookup survives an all-cache-hit resolve', () => {
  let vaultRoot: string;
  let eventLog: EventLog;

  beforeEach(async () => {
    resetGistLookupMemoForTest();
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-gist-cachehit-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
    await appendContentEnrichmentEvent(eventLog, {
      payloadVersion: 1,
      kind: 'url',
      id: URL_ID,
      gist: GIST,
      sourceContentHash: 'h1',
      model: 'apple-foundationmodel',
      generatedAt: '2026-07-28T11:00:00.000Z',
    });
    resetGistLookupMemoForTest();
  });

  afterEach(async () => {
    resetGistLookupMemoForTest();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('loads the gist when there is no merged log to fold (the cache-hit path)', async () => {
    // What the fixed call site does when misses === 0.
    const lookup = await loadGistLookup(vaultRoot, eventLog);
    expect(lookupGist(lookup, 'url', URL_ID)).toBe(GIST);
  });

  it('folding an EMPTY array yields nothing — which is why it must not be used there', async () => {
    const signature = await eventLog.logSignature();
    const folded = gistLookupFromMerged(vaultRoot, signature, []);
    // This is the trap, asserted so it stays visible: the fold is not wrong,
    // it is being asked the wrong question. [] genuinely contains no gists.
    expect(lookupGist(folded, 'url', URL_ID)).toBeUndefined();
  });

  it('an empty fold POISONS the shared memo for the same signature', async () => {
    // The part that made this bug outlive the request that caused it: the empty
    // result is cached under the real log signature, so a later correct caller
    // gets the blank one back.
    const signature = await eventLog.logSignature();
    gistLookupFromMerged(vaultRoot, signature, []);
    const afterPoison = await loadGistLookup(vaultRoot, eventLog);
    expect(lookupGist(afterPoison, 'url', URL_ID)).toBeUndefined();

    // ...and loading FIRST is what keeps it correct — the ordering the fix
    // guarantees by never folding [] in the first place.
    resetGistLookupMemoForTest();
    const clean = await loadGistLookup(vaultRoot, eventLog);
    expect(lookupGist(clean, 'url', URL_ID)).toBe(GIST);
    // A subsequent fold on the same signature now hits the GOOD memo.
    expect(lookupGist(gistLookupFromMerged(vaultRoot, signature, []), 'url', URL_ID)).toBe(GIST);
  });

  it('still folds correctly when the merged log IS available (the miss path)', async () => {
    const signature = await eventLog.logSignature();
    const merged = await eventLog.readMerged();
    const folded = gistLookupFromMerged(vaultRoot, signature, merged);
    expect(lookupGist(folded, 'url', URL_ID)).toBe(GIST);
  });
});
