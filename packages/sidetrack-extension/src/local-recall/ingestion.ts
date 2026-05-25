// Extension OPFS local recall — visit ingestion.
//
// Subscribes to existing navigation/timeline events so every visit
// lands in the local SQLite store. The store is then queried as a
// fallback when /v2/recall is slow or unavailable.

import { localRecallStore } from './store.js';

/** Ingest a single visit. Idempotent — called from navigation events
 *  AND from tab updates AND from the existing timeline-event writer
 *  (cheap upsert; the SQLite upsert handles dedupe). */
export const ingestVisit = async (input: {
  readonly canonicalUrl: string;
  readonly title?: string;
  readonly seenAtMs?: number;
}): Promise<void> => {
  if (!/^https?:\/\//iu.test(input.canonicalUrl)) return;
  try {
    await localRecallStore().recordVisit(input);
  } catch (err) {
    // Local store is best-effort — never block navigation on it.
    console.warn('[local-recall] ingest failed:', err);
  }
};

/** Bulk-ingest from existing storage on first install / SW restart.
 *  Reads navigation events from chrome.storage.local and seeds the
 *  store. No-op when called repeatedly (upsert dedupes). */
export const bulkIngestFromStorage = async (
  visits: readonly { readonly canonicalUrl: string; readonly title?: string; readonly seenAtMs?: number }[],
): Promise<number> => {
  let n = 0;
  for (const v of visits) {
    await ingestVisit(v);
    n += 1;
  }
  return n;
};
