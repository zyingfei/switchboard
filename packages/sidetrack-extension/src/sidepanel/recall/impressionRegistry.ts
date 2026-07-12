// P2 — cross-surface impression registry.
//
// The companion trains its ranker by joining `recall.action` events to
// the `recall.served` impression that showed the candidate, matching
// on the served results[].entityId by EXACT string equality
// (packages/sidetrack-companion/src/ranker/retrain-impressions.ts).
// The sidepanel's recall-served surfaces (Search, the Now-card Related
// strip, the FocusView add-drawer, Déjà-vu See-all) all parse the /v2
// response and then drop meta.servedContextId, so a later feedback
// gesture on a served candidate had no impression to join. This
// registry keeps a short-lived in-memory map from served entityId
// (and canonicalUrl) back to { servedContextId, servedEntityId } so
// the emission helper (emitTrainableAction.ts) can mirror feedback
// gestures as impression-joined trainable actions.
//
// Module-level singleton on purpose: all four surfaces live in the
// same sidepanel document, and the registry must survive component
// remounts the same way focusedRelated.ts's module cache does.
//
// URL-index collision policy: within one recordImpression batch, when
// two hits share a urlKey (slash variants of the same page, or a
// page_content row plus a chat_turn that links to it), the hit whose
// canonicalUrl equals the urlKey EXACTLY wins over a slash-variant
// row. ACROSS batches plain last-write-wins applies — the newest
// serve is the list the user is looking at. byEntityId entries carry
// a urlKey back-pointer so re-serving an entity WITHOUT a
// canonicalUrl deletes its now-stale byUrlKey row in O(1) instead of
// leaving a dangling join to the older served context.

export interface ImpressionHitInput {
  readonly entityId: string;
  readonly canonicalUrl?: string;
}

export interface ImpressionLookup {
  /** Impression id the companion stamped on the /v2 response meta. */
  readonly servedContextId: string;
  /** The entityId EXACTLY as it appeared in the /v2 response. The
   *  companion joins actions to impressions by exact string match
   *  against served.results[].entityId, so this is stored and
   *  returned verbatim — never a candidateId, anchor-node synthesis,
   *  or re-canonicalized URL. */
  readonly servedEntityId: string;
}

interface RegistryEntry {
  readonly servedContextId: string;
  readonly servedEntityId: string;
  readonly atMs: number;
  /** Back-pointer to the byUrlKey row this entry owns. Set only when
   *  the row was actually written (a hit skipped by the within-batch
   *  exact-URL preference carries none), so the stale-row cleanup in
   *  recordImpression never deletes a row belonging to another
   *  entity. */
  readonly urlKey?: string;
}

// 15 min: comfortably longer than the Related strip's 5-min response
// cache (the longest-lived re-serve of a parsed response), so a
// cache-served row still resolves to its original impression. Older
// entries are treated as misses — a stale join would credit the wrong
// impression.
const IMPRESSION_TTL_MS = 15 * 60_000;
// Hard cap so a long search session can't grow the maps unbounded.
// Eviction is oldest-first; Map insertion order is refreshed on every
// record (delete-before-set), so "oldest" ≈ least-recently served.
const MAX_ENTRIES = 1000;

const byEntityId = new Map<string, RegistryEntry>();
const byUrlKey = new Map<string, RegistryEntry>();

// Same slash-normalization the Related strip uses (focusedRelated.ts
// urlKeyOf): canonicalization drift in the vault means the same page
// shows up with and without a trailing slash, so URL keys compare on
// the normalized form for both record and lookup.
const urlKeyOf = (url: string): string => (url.endsWith('/') ? url.slice(0, -1) : url);

const pruneAndCap = (index: Map<string, RegistryEntry>, nowMs: number): void => {
  for (const [key, entry] of index) {
    if (nowMs - entry.atMs >= IMPRESSION_TTL_MS) index.delete(key);
  }
  while (index.size > MAX_ENTRIES) {
    const oldest = index.keys().next().value;
    if (oldest === undefined) return;
    index.delete(oldest);
  }
};

/** Record a served recall batch. Most-recent-wins per key: when two
 *  impressions serve the same entity, an action joins the latest one
 *  (that is the list the user is looking at). See the module comment
 *  for the within-batch urlKey collision policy. */
export const recordImpression = (
  servedContextId: string,
  hits: ReadonlyArray<ImpressionHitInput>,
): void => {
  if (servedContextId.length === 0) return;
  const atMs = Date.now();
  // urlKeys already claimed IN THIS BATCH by a hit whose canonicalUrl
  // equals the key exactly — slash-variant rows must not overwrite
  // those; across batches last-write-wins (the set starts empty).
  const exactUrlKeysThisBatch = new Set<string>();
  for (const hit of hits) {
    if (hit.entityId.length === 0) continue;
    const previous = byEntityId.get(hit.entityId);
    const canonicalUrl =
      hit.canonicalUrl !== undefined && hit.canonicalUrl.length > 0 ? hit.canonicalUrl : undefined;
    const key = canonicalUrl === undefined ? undefined : urlKeyOf(canonicalUrl);
    const isExactUrl = canonicalUrl !== undefined && canonicalUrl === key;
    const writesUrlRow = key !== undefined && (isExactUrl || !exactUrlKeysThisBatch.has(key));
    const entry: RegistryEntry = {
      servedContextId,
      servedEntityId: hit.entityId,
      atMs,
      ...(writesUrlRow && key !== undefined ? { urlKey: key } : {}),
    };
    // Delete-before-set keeps Map insertion order aligned with
    // recency, which is what the cap eviction above relies on.
    byEntityId.delete(hit.entityId);
    byEntityId.set(hit.entityId, entry);
    // Cross-index cleanup via the back-pointer: this entity previously
    // owned a byUrlKey row under a different (or now absent) key.
    // Delete it only if it still points at this entity — another
    // entity's later serve may have claimed the key since.
    const staleKey = previous?.urlKey;
    if (staleKey !== undefined && staleKey !== entry.urlKey) {
      const stale = byUrlKey.get(staleKey);
      if (stale !== undefined && stale.servedEntityId === hit.entityId) {
        byUrlKey.delete(staleKey);
      }
    }
    if (writesUrlRow && key !== undefined) {
      byUrlKey.delete(key);
      byUrlKey.set(key, entry);
      if (isExactUrl) exactUrlKeysThisBatch.add(key);
    }
  }
  pruneAndCap(byEntityId, atMs);
  pruneAndCap(byUrlKey, atMs);
};

const lookupIn = (index: Map<string, RegistryEntry>, key: string): ImpressionLookup | null => {
  const entry = index.get(key);
  if (entry === undefined || Date.now() - entry.atMs >= IMPRESSION_TTL_MS) return null;
  return { servedContextId: entry.servedContextId, servedEntityId: entry.servedEntityId };
};

export const lookupByEntityId = (id: string): ImpressionLookup | null => lookupIn(byEntityId, id);

/** Secondary index — the served candidate's canonicalUrl, tolerant of
 *  trailing-slash variants on both the recorded and looked-up side. */
export const lookupByUrl = (url: string): ImpressionLookup | null =>
  lookupIn(byUrlKey, urlKeyOf(url));

/** Record straight off a raw /v2/recall response: meta.servedContextId
 *  plus results[] exactly as parsed off the wire (unknown-shaped —
 *  the extension deliberately doesn't import companion types). Rows
 *  without a string entityId are skipped; a missing/blank
 *  servedContextId makes the whole call a no-op. */
export const recordImpressionFromRecallResults = (
  servedContextId: unknown,
  results: readonly unknown[],
): void => {
  if (typeof servedContextId !== 'string' || servedContextId.length === 0) return;
  const hits: ImpressionHitInput[] = [];
  for (const raw of results) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as { readonly entityId?: unknown; readonly canonicalUrl?: unknown };
    if (typeof r.entityId !== 'string' || r.entityId.length === 0) continue;
    hits.push({
      entityId: r.entityId,
      ...(typeof r.canonicalUrl === 'string' && r.canonicalUrl.length > 0
        ? { canonicalUrl: r.canonicalUrl }
        : {}),
    });
  }
  if (hits.length > 0) recordImpression(servedContextId, hits);
};

/** Record from already-mapped served items that carry a per-item
 *  servedContextId (the Déjà-vu See-all handoff). Items missing
 *  either id are skipped — old senders simply don't feed the
 *  registry. */
export const recordImpressionFromServedItems = (
  items: ReadonlyArray<{
    readonly entityId?: string;
    readonly servedContextId?: string;
    readonly canonicalUrl?: string;
  }>,
): void => {
  const hitsByContext = new Map<string, ImpressionHitInput[]>();
  for (const item of items) {
    if (item.entityId === undefined || item.entityId.length === 0) continue;
    if (item.servedContextId === undefined || item.servedContextId.length === 0) continue;
    const hits = hitsByContext.get(item.servedContextId) ?? [];
    hits.push({
      entityId: item.entityId,
      ...(item.canonicalUrl !== undefined && item.canonicalUrl.length > 0
        ? { canonicalUrl: item.canonicalUrl }
        : {}),
    });
    hitsByContext.set(item.servedContextId, hits);
  }
  for (const [servedContextId, hits] of hitsByContext) {
    recordImpression(servedContextId, hits);
  }
};

/** Testing-only — the registry is a module-level singleton. */
export const resetImpressionRegistryForTests = (): void => {
  byEntityId.clear();
  byUrlKey.clear();
};
