import { idempotencyKey } from '../../idempotencyKey';
import { messageTypes } from '../../messages';
// Type-only on purpose: client.ts calls this helper from its feedback
// choke point, so a runtime import back into client.ts would be an
// import cycle. Event types below are compared as string literals —
// the envelope's discriminant is a literal union, so a typo is a
// compile error ("comparison appears to be unintentional").
import type { FeedbackEventEnvelope } from '../connections/client';
import { lookupByEntityId, lookupByUrl, type ImpressionLookup } from './impressionRegistry';

// P2 — mirror an explicit feedback gesture as a trainable
// `recall.action` when the judged subject was recently recall-served.
// The déjà-vu content script already emits engagement-only kinds
// (click/open_new_tab); the sidepanel's gestures are the EXPLICIT
// kinds the batch trainer turns into labels (flow_confirm/move/
// promote/snippet_promote → positive, flow_reject/ignore → negative).

export interface TrainableActionSpec {
  readonly actionKind:
    | 'flow_confirm'
    | 'flow_reject'
    | 'snippet_promote'
    | 'move'
    | 'promote'
    | 'ignore';
  readonly subjectId: string;
}

/** Derive { actionKind, subjectId } from a feedback envelope.
 *
 * MIRRORS the companion's historicalFeedbackSpecFor
 * (packages/sidetrack-companion/src/ranker/retrain-impressions.ts):
 * subjectId is that reconstructor's targetEntityId, so the live emit
 * and the batch reconstruction of the SAME gesture judge the same
 * served entity — referencesEventId then lets the trainer skip the
 * reconstruction instead of double-counting. Exported for tests. */
export const trainableActionSpecFor = (event: FeedbackEventEnvelope): TrainableActionSpec | null => {
  if (event.type === 'user.flow.confirmed') {
    return { actionKind: 'flow_confirm', subjectId: event.payload.toId };
  }
  if (event.type === 'user.flow.rejected') {
    return { actionKind: 'flow_reject', subjectId: event.payload.toId };
  }
  if (event.type === 'user.snippet.promoted') {
    return { actionKind: 'snippet_promote', subjectId: event.payload.targetId };
  }
  if (event.type === 'user.organized.item') {
    const action = event.payload.action;
    // Only move/promote/ignore are judgements about a served
    // candidate; rename/merge/split say nothing about relevance and
    // the companion reconstructor skips them too.
    if (action !== 'move' && action !== 'promote' && action !== 'ignore') return null;
    return { actionKind: action, subjectId: event.payload.itemId };
  }
  return null;
};

// The background persists UiSettings under this chrome.storage.local
// key (src/background/state.ts SETTINGS_KEY — not imported here since
// state.ts is background-only and would drag queue/outbox modules into
// the sidepanel bundle). saveLocalPreferences writes the flag through
// that same document; reading storage directly (like ProducerPin.tsx
// does for pins) keeps this helper free of workboard-state plumbing.
const SETTINGS_STORAGE_KEY = 'sidetrack.settings';

// Kill-switch semantics, mirroring how captureEnabled is read: absent
// key or absent flag = ON, only an explicit `false` silences emission.
const readEmitEnabled = async (): Promise<boolean> => {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const settings = stored[SETTINGS_STORAGE_KEY] as
    | { readonly recallEmitTrainableActions?: unknown }
    | undefined;
  return settings?.recallEmitTrainableActions !== false;
};

const TIMELINE_VISIT_PREFIX = 'timeline-visit:';

/** Resolve a gesture subject to its recent impression, if any.
 *
 * Namespace bridge: served /v2 entityIds are 'url:<sha>'/'thread:<id>'/
 * 'id:<...>' (companion recall-v2/pipeline.ts entityIdFor) while
 * gesture subjects are graph-node ids like 'timeline-visit:<url>'.
 * MIRRORS the companion's own batch join (candidateMatchesTarget,
 * retrain-impressions.ts): try the raw id for exact-namespace matches,
 * then strip the timeline-visit: prefix and match on canonicalUrl.
 * A miss is the COMMON case (subject never recall-served, or the
 * impression aged out) — callers treat null as a silent no-op. */
const lookupServedHit = (subjectId: string): ImpressionLookup | null => {
  const exact = lookupByEntityId(subjectId);
  if (exact !== null) return exact;
  if (subjectId.startsWith(TIMELINE_VISIT_PREFIX)) {
    return lookupByUrl(subjectId.slice(TIMELINE_VISIT_PREFIX.length));
  }
  return /^https?:\/\//u.test(subjectId) ? lookupByUrl(subjectId) : null;
};

/** Shared fire-and-forget tail: preference gate + runtime message.
 *  referencesEventId must already be the EXACT clientEventId the
 *  companion stored for the mirrored feedback event — each caller owns
 *  that transform because the routes differ (see call sites). */
const emitForHit = (
  hit: ImpressionLookup,
  actionKind: TrainableActionSpec['actionKind'],
  referencesEventId: string,
): void => {
  const payload = {
    payloadVersion: 1,
    servedContextId: hit.servedContextId,
    // The registry returns the entityId byte-exact as served — the
    // trainer joins on exact string match against results[].entityId.
    entityId: hit.servedEntityId,
    actionKind,
    actionAt: new Date().toISOString(),
    referencesEventId,
  };
  void (async () => {
    if (!(await readEmitEnabled())) return;
    await chrome.runtime.sendMessage({ type: messageTypes.recallActionEmit, payload });
  })().catch(() => {
    // Fire-and-forget: a lost emit is one missing training label, not
    // a user-visible failure.
  });
};

/** Fire-and-forget mirror of a feedback envelope as a recall.action.
 *
 * MUST be called with the EXACT envelope object and clientEventId
 * string that go to the feedback POST: feedbackClientEventId hashes
 * JSON.stringify(payload) (key-order sensitive), and the companion
 * dedupes by matching recall.action.referencesEventId against the
 * STORED feedback event's clientEventId — a rebuilt lookalike envelope
 * would break the dedupe and double-count the gesture. */
export const maybeEmitTrainableRecallAction = (
  event: FeedbackEventEnvelope,
  clientEventId: string,
): void => {
  const spec = trainableActionSpecFor(event);
  if (spec === null) return;
  const hit = lookupServedHit(spec.subjectId);
  if (hit === null) return;
  // The feedback POST path transforms the client id before storage:
  // background postConnectionsFeedbackHttp sends the header
  // idempotencyKey('feedback', clientEventId) (re-prefix + sanitize)
  // and the companion stores that HEADER as the accepted event's
  // clientEventId (server.ts /v1/feedback/events). This single choke
  // point owns the same transform so referencesEventId string-equals
  // the stored id; background relays the payload verbatim.
  emitForHit(hit, spec.actionKind, idempotencyKey('feedback', clientEventId));
};

/** Fire-and-forget mirror for the URL-attribute flow.
 *
 * POST /v1/visits/:canonicalUrl/attribute creates the
 * user.organized.item SERVER-side (companion server.ts), so the
 * gesture never passes the postFeedbackEvent /
 * recordOrganizedItemFeedback choke points above. That route records
 * action 'move' for assign AND unassign (unassign is just
 * toContainer:null — still trainable) and stores the request's
 * idempotency-key header VERBATIM as the accepted event's
 * clientEventId (no 'feedback-' re-prefix like /v1/feedback/events),
 * so the caller passes the exact header string it sent. */
export const maybeEmitTrainableRecallActionForUrlAttribute = (
  canonicalUrl: string,
  attributeIdempotencyKey: string,
): void => {
  const hit = lookupServedHit(canonicalUrl);
  if (hit === null) return;
  emitForHit(hit, 'move', attributeIdempotencyKey);
};
