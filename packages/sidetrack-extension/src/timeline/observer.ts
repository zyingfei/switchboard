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
//   1. Same (tabIdHash, canonicalUrl) within `coalesceWindowMs` →
//      no emission. Title updates merge in-memory.
//   2. Same tabIdHash, new canonicalUrl → emit (navigation).
//   3. New tabIdHash → emit.
//   4. Title-only change → no emission.
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
}

export interface CloseInput {
  readonly tabId: number;
  readonly windowId: number;
}

interface TabState {
  readonly tabIdHash: string;
  readonly windowIdHash: string;
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly provider?: TimelineProvider;
  readonly title?: string;
  readonly lastEmittedAt: number; // ms epoch
}

export interface TimelineObserver {
  readonly observe: (input: ObserveInput) => void;
  readonly close: (input: CloseInput) => void;
}

const defaultMintEventId = (input: {
  tabIdHash: string;
  canonicalUrl?: string;
  url: string;
  observedAt: string;
}): string => {
  const key = `${input.tabIdHash}|${input.canonicalUrl ?? input.url}|${input.observedAt}`;
  return `tl_${key}`;
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
    // Bound URL + title before doing any other work. An oversized
    // input is dropped silently (passive intent — same posture as
    // the budget guard's `dropped-passive-by-policy`).
    if (input.url.length > URL_MAX_LENGTH) return;
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
    const canonicalUrl =
      rawCanonical === undefined ? undefined : sanitizeTimelineUrl(rawCanonical);
    const provider = deps.providerOf?.(canonicalUrl ?? sanitizedUrl);
    const existing = byTab.get(tabIdHash);

    const isSameUrl = (() => {
      if (existing === undefined) return false;
      const left = existing.canonicalUrl ?? existing.url;
      const right = canonicalUrl ?? sanitizedUrl;
      return left === right;
    })();

    if (isSameUrl && existing !== undefined) {
      // Coalesce within the window — no emission.
      const elapsed = now.getTime() - existing.lastEmittedAt;
      if (elapsed < coalesceWindowMs) {
        // Title-only update merges in-memory.
        if (boundedTitle !== undefined && boundedTitle !== existing.title) {
          byTab.set(tabIdHash, { ...existing, title: boundedTitle });
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
      };
      deps.emit(payload);
      byTab.set(tabIdHash, {
        tabIdHash,
        windowIdHash,
        url: sanitizedUrl,
        ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
        ...(provider === undefined ? {} : { provider }),
        ...(boundedTitle === undefined ? {} : { title: boundedTitle }),
        lastEmittedAt: now.getTime(),
      });
      return;
    }

    // New tab OR navigation to a new canonicalUrl — emit.
    const transition: TimelineTransition =
      existing === undefined ? input.transition : 'updated';
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
    };
    deps.emit(payload);
    byTab.set(tabIdHash, {
      tabIdHash,
      windowIdHash,
      url: sanitizedUrl,
      ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
      ...(provider === undefined ? {} : { provider }),
      ...(boundedTitle === undefined ? {} : { title: boundedTitle }),
      lastEmittedAt: now.getTime(),
    });
  };

  const close = (input: CloseInput): void => {
    const tabIdHash = deps.hashTabId(input.tabId, input.windowId);
    const existing = byTab.get(tabIdHash);
    if (existing === undefined) return;
    const observedAt = deps.clock().toISOString();
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
    };
    deps.emit(payload);
    byTab.delete(tabIdHash);
  };

  return { observe, close };
};
