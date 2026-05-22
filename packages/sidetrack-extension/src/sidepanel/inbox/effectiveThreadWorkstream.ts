// "Derive now" half of the chat-attribution convergence.
//
// A captured chat is one concept with three ids (thread bac_id,
// tab-session, canonical URL) and separate attribution stores. The
// side panel's "All threads" / Workstream views bucket by the
// extension-local `thread.primaryWorkstreamId`, which is ONLY written
// by an explicit thread upsert — so filing a chat via the Inbox
// (which writes the URL attribution) left the thread "ungrouped".
//
// Convergence principle (same one applied companion-side in
// urlAttributionOverlay.ts): the URL attribution is the canonical
// "where does this chat belong" decision; a thread with no own
// workstream derives it from its URL at read time. Pure + generic so
// it is unit-tested and reused at every bucketing seam. Display-only:
// write-path reads (move fromContainer, dispatch targeting) keep the
// raw stored value.

interface UrlAttributionLike {
  readonly workstreamId?: string | null;
}
interface UrlRecordLike {
  readonly currentAttribution?: UrlAttributionLike;
}
export interface UrlProjectionLike {
  readonly byCanonicalUrl: Record<string, UrlRecordLike | undefined>;
}

/**
 * The workstream "All threads" / Workstream views should bucket this
 * thread under: its own `primaryWorkstreamId` if set, else the
 * workstream its canonical URL was filed into (the Inbox pick).
 * `undefined` ⇒ genuinely ungrouped.
 */
export const effectiveThreadWorkstreamId = (
  thread: { readonly primaryWorkstreamId?: string; readonly threadUrl?: string },
  urlProjection: UrlProjectionLike | null | undefined,
  canonicalize: (url: string) => string,
): string | undefined => {
  if (thread.primaryWorkstreamId !== undefined) return thread.primaryWorkstreamId;
  if (urlProjection == null || thread.threadUrl === undefined) return undefined;
  const ws = urlProjection.byCanonicalUrl[canonicalize(thread.threadUrl)]?.currentAttribution
    ?.workstreamId;
  return typeof ws === 'string' && ws.length > 0 ? ws : undefined;
};

/**
 * Returns the thread with its bucketing workstream filled from the URL
 * attribution when its own is unset; otherwise the same object
 * (referential stability — no needless re-renders).
 */
export const withEffectiveThreadWorkstream = <
  T extends { readonly primaryWorkstreamId?: string; readonly threadUrl?: string },
>(
  thread: T,
  urlProjection: UrlProjectionLike | null | undefined,
  canonicalize: (url: string) => string,
): T => {
  if (thread.primaryWorkstreamId !== undefined) return thread;
  const ws = effectiveThreadWorkstreamId(thread, urlProjection, canonicalize);
  return ws === undefined ? thread : { ...thread, primaryWorkstreamId: ws };
};
