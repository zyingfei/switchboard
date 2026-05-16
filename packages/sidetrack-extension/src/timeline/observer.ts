import type {
  BrowserTimelineObservedPayload,
  TimelineProvider,
  TimelineTransition,
} from './events';
import { sanitizeTimelineUrl } from './sanitize';

// Reviewer-flagged: bound URL/title sizes at the observer so a
// pathological tab (10 MB chrome:// URL, etc.) can't push the
// companion's payload predicate to reject after the spool has
// already paid the cost of admit + edge dot allocation. Matches the
// companion-side limits in `packages/sidetrack-companion/src/
// timeline/events.ts`.
const URL_MAX_LENGTH = 4096;
const TITLE_MAX_LENGTH = 1024;

// Sync Contract v1 / Class F — passive timeline observer.
//
// Listens for tab activation / navigation observations and emits
// `browser.timeline.observed` payloads with debounce + coalescing.
//
// Coalescing rules (from docs/timeline.md):
//   1. Same (tabIdHash, canonicalUrl, title) within `coalesceWindowMs` →
//      no emission.
//   2. Same tabIdHash, new canonicalUrl → emit (navigation).
//   3. New tabIdHash → emit.
//   4. Same canonicalUrl with a CHANGED title within the coalesce
//      window → emit (projection captures the new latestTitle). SPAs
//      like chatgpt.com set document.title long after status:complete,
//      and the title is what makes Inbox / current-tab cards human-
//      readable.
//   5. Tab close → emit `transition: 'closed'` for the last URL of
//      that tab.
//
// The observer is decoupled from chrome.tabs so tests can drive it
// with synthetic observations. The chrome wiring lives next to
// background.ts and bridges chrome.tabs events into observer.observe.
//
// SW-restart behavior (reviewer-flagged): the `byTab` map is
// in-memory only. After a service-worker restart (Chrome cycles
// MV3 SWs aggressively), the map is empty — so the next
// chrome.tabs event for a tab that was already in steady state
// looks "new" and emits `transition: 'activated'`. This is mildly
// noisy under heavy SW recycling but harmless: each emission goes
// through the standard coalesce + spool admit path, the daily
// projection reduces them by canonicalUrl, and visitCount
// represents observations not unique sessions. If a future
// iteration cares about precise session boundaries, persist
// `byTab` in chrome.storage on each emit.

export interface TimelineObserverDeps {
  // Wall-clock for now() + debounce decisions. Inject for tests.
  readonly clock: () => Date;
  // Emits the payload. The plugin materializer's admitLocal is the
  // typical sink. Errors are caller's concern.
  readonly emit: (payload: BrowserTimelineObservedPayload) => void;
  // Hashes (tabId, windowId, edgeReplicaId) → opaque string.
  // Companion never sees raw tabId.
  readonly hashTabId: (tabId: number, windowId: number) => string;
  readonly hashWindowId: (windowId: number) => string;
  // Optional canonicalizer; receives the raw URL and may return a
  // canonical form (provider URL with query/fragment stripped).
  // Default: identity.
  readonly canonicalize?: (url: string) => string | undefined;
  // Optional provider classifier; default: undefined.
  readonly providerOf?: (url: string) => TimelineProvider | undefined;
  // Window during which a duplicate (tabIdHash, canonicalUrl) is
  // suppressed. Default: 30 s.
  readonly coalesceWindowMs?: number;
  // Stable per-emission id minter. Default: combine tabIdHash +
  // canonicalUrl + observedAt.
  readonly mintEventId?: (input: {
    tabIdHash: string;
    canonicalUrl?: string;
    url: string;
    observedAt: string;
  }) => string;
}

export interface ObserveInput {
  readonly tabId: number;
  readonly windowId: number;
  readonly url: string;
  readonly title?: string;
  readonly transition: TimelineTransition;
  readonly tabSessionId?: string;
  readonly openerTabSessionId?: string;
  // 2026-05 fix: the active-workstream pointer at observation time.
  // Stamped on every emitted payload so the companion's projection
  // can roll it onto the TimelineEntry → snapshot's timeline-visit
  // node metadata → `visit_in_workstream` edge. This is the ambient
  // attribution path used when no Class A user assertion exists for
  // a URL (the user is just browsing inside a focused workstream).
  readonly workstreamId?: string;
}

export interface CloseInput {
  readonly tabId: number;
  readonly windowId: number;
  readonly tabSessionId?: string;
  readonly openerTabSessionId?: string;
}

interface TabState {
  readonly tabIdHash: string;
  readonly windowIdHash: string;
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly provider?: TimelineProvider;
  readonly title?: string;
  readonly tabSessionId?: string;
  readonly openerTabSessionId?: string;
  readonly lastEmittedAt: number; // ms epoch
}

export interface TimelineObserver {
  readonly observe: (input: ObserveInput) => void;
  readonly close: (input: CloseInput) => void;
}

export interface TimelineObserverDiagnostics {
  readonly observeCalls: number;
  readonly emitCalls: number;
  readonly closeCalls: number;
  readonly coalescedCalls: number;
  readonly droppedUrlTooLong: number;
  readonly closeDroppedMissingTab: number;
  readonly lastDecision: null | {
    readonly at: string;
    readonly kind: 'emit' | 'coalesce' | 'drop-url-too-long' | 'close-emit' | 'close-missing-tab';
    readonly transition?: TimelineTransition;
    readonly sanitizedUrl?: string;
    readonly canonicalUrl?: string;
    readonly hasTabSessionId?: boolean;
    readonly urlLength?: number;
  };
}

let observeCalls = 0;
let emitCalls = 0;
let closeCalls = 0;
let coalescedCalls = 0;
let droppedUrlTooLong = 0;
let closeDroppedMissingTab = 0;
let lastDecision: TimelineObserverDiagnostics['lastDecision'] = null;

export const getTimelineObserverDiagnostics = (): TimelineObserverDiagnostics => ({
  observeCalls,
  emitCalls,
  closeCalls,
  coalescedCalls,
  droppedUrlTooLong,
  closeDroppedMissingTab,
  lastDecision,
});

// FNV-1a 32-bit hash — sync, no async crypto.subtle dependency, plenty
// of identifier-space for the eventId's URL slot (collision risk on a
// per-(tabIdHash, observedAt) tuple is negligible because the
// timestamp is included in the surrounding key).
const fnv1a32Hex = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

// Stage 5 follow-up — Google search URLs (and other long
// query-string URLs like marketing landing pages with utm_* +
// gad_campaignid + sxsrf etc) routinely produce 500+ char URLs.
// Embedding the full URL into the eventId pushed past the
// companion's TIMELINE_EVENT_ID_MAX_LENGTH (256), which causes the
// `/v1/timeline/events` POST to skip them with `invalid-payload`.
// The drainer never gets an ack, the entries pile up in
// `pending-send` forever, and the user sees "no tracked tab" for
// the search URL because it never lands in the vault.
//
// Hash the URL portion to FNV-1a32; the eventId is now bounded by
// `tl_<16hex>|<8hex>|<24-char-iso>` ≈ 56 chars.
const defaultMintEventId = (input: {
  tabIdHash: string;
  canonicalUrl?: string;
  url: string;
  observedAt: string;
}): string => {
  const urlForHash = input.canonicalUrl ?? input.url;
  const urlHash = fnv1a32Hex(urlForHash);
  return `tl_${input.tabIdHash}|${urlHash}|${input.observedAt}`;
};

export const createTimelineObserver = (deps: TimelineObserverDeps): TimelineObserver => {
  const coalesceWindowMs = deps.coalesceWindowMs ?? 30_000;
  const mintEventId = deps.mintEventId ?? defaultMintEventId;
  // Per-tab-hash state. Key is tabIdHash so a closed tab's state is
  // dropped when the next observation comes in (we don't grow this
  // unbounded). For passive intent + bounded tabs per browser, the
  // table stays small.
  const byTab = new Map<string, TabState>();

  const observe = (input: ObserveInput): void => {
    observeCalls += 1;
    // Bound URL + title before doing any other work. An oversized
    // input is dropped silently (passive intent — same posture as
    // the budget guard's `dropped-passive-by-policy`).
    if (input.url.length > URL_MAX_LENGTH) {
      droppedUrlTooLong += 1;
      lastDecision = {
        at: deps.clock().toISOString(),
        kind: 'drop-url-too-long',
        transition: input.transition,
        urlLength: input.url.length,
      };
      return;
    }
    const boundedTitle =
      input.title === undefined
        ? undefined
        : input.title.length > TITLE_MAX_LENGTH
          ? input.title.slice(0, TITLE_MAX_LENGTH)
          : input.title;
    const now = deps.clock();
    const observedAt = now.toISOString();
    const tabIdHash = deps.hashTabId(input.tabId, input.windowId);
    const windowIdHash = deps.hashWindowId(input.windowId);
    // Reviewer-flagged: sanitize the raw URL BEFORE it enters the
    // payload OR the in-memory state. Strips fragments + sensitive
    // query params (token / code / state / session / key / secret /
    // password / auth / sig / signature / ...). Also sanitize the
    // canonical form — canonicalThreadUrl is a no-op for non-
    // provider URLs, so without this layer auth tokens in
    // arbitrary URLs would still ship to the companion.
    const sanitizedUrl = sanitizeTimelineUrl(input.url);
    const rawCanonical = deps.canonicalize?.(input.url);
    const canonicalUrl = rawCanonical === undefined ? undefined : sanitizeTimelineUrl(rawCanonical);
    const provider = deps.providerOf?.(canonicalUrl ?? sanitizedUrl);
    const existing = byTab.get(tabIdHash);

    const isSameUrl = (() => {
      if (existing === undefined) return false;
      const left = existing.canonicalUrl ?? existing.url;
      const right = canonicalUrl ?? sanitizedUrl;
      return left === right;
    })();

    if (isSameUrl && existing !== undefined) {
      // Real-page title typically loads a beat after status:complete fires,
      // so the very first observation for a URL often has no title and the
      // second one (carrying the title) lands inside the coalesce window.
      // ChatGPT/Claude/Gemini also update document.title several seconds
      // later when a chat acquires a subject. We coalesce on URL but
      // ALWAYS emit when the title changes to a new non-empty value —
      // otherwise the companion's tab-session projection never gets a
      // useful `latestTitle` and the Inbox / current-tab card stays stuck
      // displaying raw URLs.
      const titleChanged = boundedTitle !== undefined && existing.title !== boundedTitle;
      const elapsed = now.getTime() - existing.lastEmittedAt;
      if (elapsed < coalesceWindowMs && !titleChanged) {
        coalescedCalls += 1;
        lastDecision = {
          at: observedAt,
          kind: 'coalesce',
          transition: input.transition,
          sanitizedUrl,
          ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
          hasTabSessionId: input.tabSessionId !== undefined,
        };
        // In-memory merge so subsequent comparisons see the latest title /
        // session ids, even though we don't emit.
        if (
          boundedTitle !== undefined ||
          input.tabSessionId !== existing.tabSessionId ||
          input.openerTabSessionId !== existing.openerTabSessionId
        ) {
          byTab.set(tabIdHash, {
            ...existing,
            ...(boundedTitle === undefined ? {} : { title: boundedTitle }),
            ...(input.tabSessionId === undefined ? {} : { tabSessionId: input.tabSessionId }),
            ...(input.openerTabSessionId === undefined
              ? {}
              : { openerTabSessionId: input.openerTabSessionId }),
          });
        }
        return;
      }
      // Outside the window — emit a refresh observation as 'updated'.
      const payload: BrowserTimelineObservedPayload = {
        eventId: mintEventId({
          tabIdHash,
          ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
          url: sanitizedUrl,
          observedAt,
        }),
        observedAt,
        url: sanitizedUrl,
        ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
        ...(boundedTitle === undefined ? {} : { title: boundedTitle }),
        ...(provider === undefined ? {} : { provider }),
        transition: 'updated',
        tabIdHash,
        windowIdHash,
        ...(input.tabSessionId === undefined ? {} : { tabSessionId: input.tabSessionId }),
        ...(input.openerTabSessionId === undefined
          ? {}
          : { openerTabSessionId: input.openerTabSessionId }),
        ...(input.workstreamId === undefined || input.workstreamId.length === 0
          ? {}
          : { workstreamId: input.workstreamId }),
      };
      emitCalls += 1;
      lastDecision = {
        at: observedAt,
        kind: 'emit',
        transition: 'updated',
        sanitizedUrl,
        ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
        hasTabSessionId: input.tabSessionId !== undefined,
      };
      deps.emit(payload);
      byTab.set(tabIdHash, {
        tabIdHash,
        windowIdHash,
        url: sanitizedUrl,
        ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
        ...(provider === undefined ? {} : { provider }),
        ...(boundedTitle === undefined ? {} : { title: boundedTitle }),
        ...(input.tabSessionId === undefined ? {} : { tabSessionId: input.tabSessionId }),
        ...(input.openerTabSessionId === undefined
          ? {}
          : { openerTabSessionId: input.openerTabSessionId }),
        lastEmittedAt: now.getTime(),
      });
      return;
    }

    // New tab OR navigation to a new canonicalUrl — emit.
    const transition: TimelineTransition = existing === undefined ? input.transition : 'updated';
    const payload: BrowserTimelineObservedPayload = {
      eventId: mintEventId({
        tabIdHash,
        ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
        url: sanitizedUrl,
        observedAt,
      }),
      observedAt,
      url: sanitizedUrl,
      ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
      ...(boundedTitle === undefined ? {} : { title: boundedTitle }),
      ...(provider === undefined ? {} : { provider }),
      transition,
      tabIdHash,
      windowIdHash,
      ...(input.tabSessionId === undefined ? {} : { tabSessionId: input.tabSessionId }),
      ...(input.openerTabSessionId === undefined
        ? {}
        : { openerTabSessionId: input.openerTabSessionId }),
      ...(input.workstreamId === undefined || input.workstreamId.length === 0
        ? {}
        : { workstreamId: input.workstreamId }),
    };
    emitCalls += 1;
    lastDecision = {
      at: observedAt,
      kind: 'emit',
      transition,
      sanitizedUrl,
      ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
      hasTabSessionId: input.tabSessionId !== undefined,
    };
    deps.emit(payload);
    byTab.set(tabIdHash, {
      tabIdHash,
      windowIdHash,
      url: sanitizedUrl,
      ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
      ...(provider === undefined ? {} : { provider }),
      ...(boundedTitle === undefined ? {} : { title: boundedTitle }),
      ...(input.tabSessionId === undefined ? {} : { tabSessionId: input.tabSessionId }),
      ...(input.openerTabSessionId === undefined
        ? {}
        : { openerTabSessionId: input.openerTabSessionId }),
      lastEmittedAt: now.getTime(),
    });
  };

  const close = (input: CloseInput): void => {
    closeCalls += 1;
    const tabIdHash = deps.hashTabId(input.tabId, input.windowId);
    const existing = byTab.get(tabIdHash);
    if (existing === undefined) {
      closeDroppedMissingTab += 1;
      lastDecision = {
        at: deps.clock().toISOString(),
        kind: 'close-missing-tab',
      };
      return;
    }
    const observedAt = deps.clock().toISOString();
    const tabSessionId = input.tabSessionId ?? existing.tabSessionId;
    const openerTabSessionId = input.openerTabSessionId ?? existing.openerTabSessionId;
    const payload: BrowserTimelineObservedPayload = {
      eventId: defaultMintEventId({
        tabIdHash,
        ...(existing.canonicalUrl === undefined ? {} : { canonicalUrl: existing.canonicalUrl }),
        url: existing.url,
        observedAt,
      }),
      observedAt,
      url: existing.url,
      ...(existing.canonicalUrl === undefined ? {} : { canonicalUrl: existing.canonicalUrl }),
      ...(existing.title === undefined ? {} : { title: existing.title }),
      ...(existing.provider === undefined ? {} : { provider: existing.provider }),
      transition: 'closed',
      tabIdHash,
      windowIdHash: existing.windowIdHash,
      ...(tabSessionId === undefined ? {} : { tabSessionId }),
      ...(openerTabSessionId === undefined ? {} : { openerTabSessionId }),
    };
    emitCalls += 1;
    lastDecision = {
      at: observedAt,
      kind: 'close-emit',
      transition: 'closed',
      sanitizedUrl: existing.url,
      ...(existing.canonicalUrl === undefined ? {} : { canonicalUrl: existing.canonicalUrl }),
      hasTabSessionId: tabSessionId !== undefined,
    };
    deps.emit(payload);
    byTab.delete(tabIdHash);
  };

  return { observe, close };
};
