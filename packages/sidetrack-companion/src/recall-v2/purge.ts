// Recall-v2 derived-store privacy purge for the domain-tombstone route.
//
// The domain-tombstone route hides matching records at every READ
// boundary (via DomainTombstoneSet). This module performs the
// complementary HARD DELETE from the recall-v2 derived store (docs +
// their chunks + vectors) so a blocked site's captured recall entries
// are actually removed from disk, not merely filtered at serve time.
//
// SCOPE (the load-bearing correctness point): a HOST-scoped purge
// deletes ONLY the exact host + its own subdomains (meet.google.com and
// *.meet.google.com), leaving sibling hosts under the same eTLD+1
// (mail.google.com) untouched. A FAMILY purge (no host — legacy /
// explicitly family-wide tombstones) deletes the whole eTLD+1 family.
// Deleting MORE than the user asked destroys data for sites they wanted
// kept, so host-scoping is the privacy-CORRECT direction here.
//
// The store DB may not exist yet (recall-v2 never initialized) — that is
// a benign 0-purge. Any store error is swallowed by the caller's
// best-effort try/catch; the read-boundary filter is the durable gate.

import { existsSync } from 'node:fs';

import { RECALL_DB_PATH, openSqliteRecallStore } from './store/sqlite.js';

// Purge every recall-v2 document (and its vectors + chunks) whose `host`
// belongs to the eTLD+1 FAMILY `domain`. Returns the number of document
// rows deleted (0 when the store is absent or nothing matches).
export const purgeRecallV2StoreByDomain = (vaultRoot: string, domain: string): number => {
  const trimmed = domain.trim().toLowerCase();
  if (trimmed.length === 0) return 0;
  if (!existsSync(RECALL_DB_PATH(vaultRoot))) return 0;
  const store = openSqliteRecallStore(vaultRoot);
  try {
    return store.deleteDocumentsByHostFamily?.(trimmed) ?? 0;
  } finally {
    store.close();
  }
};

// Purge every recall-v2 document (and its vectors + chunks) whose `host`
// equals `host` OR is a subdomain of it — HOST-SCOPED. Sibling hosts
// under the same eTLD+1 SURVIVE. Returns the number of document rows
// deleted (0 when the store is absent or nothing matches).
export const purgeRecallV2StoreByHost = (vaultRoot: string, host: string): number => {
  const trimmed = host.trim().toLowerCase().replace(/\.$/u, '');
  if (trimmed.length === 0) return 0;
  if (!existsSync(RECALL_DB_PATH(vaultRoot))) return 0;
  const store = openSqliteRecallStore(vaultRoot);
  try {
    return store.deleteDocumentsByHost?.(trimmed) ?? 0;
  } finally {
    store.close();
  }
};
