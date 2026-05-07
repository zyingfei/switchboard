# Browser timeline

Timeline is a passive, bounded, privacy-aware observation stream of
the user's browser activity. The plugin records lightweight metadata
about which page is open at any moment so the user can later answer
questions like "what ChatGPT thread was I looking at last Tuesday
afternoon?" without digging through browser history.

This is the **first real future surface** that exercises Class F +
the contract extension path. It proves the architecture is open for
new high-volume passive surfaces without any contract changes.

Read [`sync-contract-v1.md`](sync-contract-v1.md),
[`plugin-edge-storage.md`](plugin-edge-storage.md), and
[`adding-a-sync-surface.md`](adding-a-sync-surface.md) first.

## What timeline captures

```
- observedAt          ISO timestamp
- url                 the navigated URL (no auth tokens, see redaction)
- canonicalUrl        canonicalized form (existing canonicalizer)
- title               page title
- provider            "chatgpt" | "claude" | "gemini" | "generic"
- transition          "activated" | "updated" | "completed" | "closed"
- tabIdHash           hash of (tabId + windowId + edgeReplicaId)
- windowIdHash        hash of (windowId + edgeReplicaId)
```

That is all. The hashes link multiple observations of the same tab
into a coherent session without leaking the raw chrome tab IDs to the
companion or relay.

## What timeline does NOT capture

```
- page body / DOM
- screenshots
- input text / keystrokes
- form values
- cookies / headers / auth tokens
- raw chrome tabId or windowId (always hashed)
- query parameters that look sensitive
  (use existing redaction utilities where available)
```

These are explicit non-goals. If a future feature needs richer
context (e.g. summarization of a page), it goes through the
extraction layer (Class E) on a per-page-visit basis with explicit
user consent — not through timeline.

## Privacy posture

Timeline is **passive** by default in the Class F admit-policy sense:

- Overflow may drop; the drop is health-visible.
- Companion offline → observations queue locally up to spool budget;
  spool full → drop-passive-by-policy.
- No screenshots, no DOM, no inputs, no cookies. The data captured is
  no more sensitive than browser history.
- All redaction utilities applied to URLs (existing canonicalizer
  drops common auth tokens).
- Companion never sees raw tab/window IDs. Only the hashed forms
  scoped by `edgeReplicaId`.

If an explicit user toggle to disable timeline ever ships, default is
**off** until consent is given. (For this initial PR the toggle is
out of scope; the feature is enabled, but bounded and privacy-careful
by default.)

## Storage budgets

| Surface | Default budget |
|---|---|
| Plugin active set (timeline entries shown / searchable locally) | 200 entries |
| Plugin spool (timeline events queued for companion drain) | shared with `maxPassivePending` (800) |
| Companion projection | daily bucket files; retention is companion-side and out of scope here |
| Archive export | inherits Class F archive policy |

Active-set count cap registered in `DEFAULT_PLUGIN_BUDGETS.activeSetCount.timeline`.

## Operating modes

### Mode P — companion offline

- Browser observations admitted to plugin active window.
- Active overflow → spool with passive intent.
- Spool overflow → `dropped-passive-by-policy`; health counter
  increments.
- Plugin local query returns `plugin-active` (or
  `plugin-active-only-companion-unreachable` once the user explicitly
  asked for a wider window).
- No companion projection update — that's normal and expected in
  Mode P.

### Mode P+C — companion reachable

- Spool drains to companion. Each entry is POSTed via
  `appendClientObserved`/`appendServerObserved` (one event per
  observation). Drain is idempotent on edge dot.
- Companion's `timeline` materializer reduces the events into the
  daily bucket projection.
- Plugin extended queries hit `GET /v1/timeline?...` and return
  `companion-extended`.

### Mode P+C+R — full sync

- Companion publishes accepted timeline events to the relay (subject
  to whatever cross-replica policy ships — for the initial PR,
  timeline events sync like any other Class A/F event).
- Peer companion's `timeline` materializer reduces the imported
  events into its own daily bucket projection.

Cross-replica timeline is useful but not load-bearing for this PR;
the primary goal is to prove the contract extends cleanly.

## Architecture

```text
chrome.tabs.onActivated / onUpdated
       │
       ▼  debounce + coalesce
       │
TimelineObserver
       │
       ▼  PluginMaterializer<TimelineEntry>.admitLocal({ intent: 'passive' })
       │
       ├─▶ active set (chrome.storage)              ← rendered + searched locally
       └─▶ spool (chrome.storage)                   ← Class F state machine
                            │
                            ▼  spoolDrainer (when companion reachable)
                            │
                            POST /v1/events (browser.timeline.observed)
                            │
                            ▼
                    companion eventLog.importPeerEvent  ← edge dot preserved
                            │
                            ▼
                    syncContractRunner.onAcceptedEvent({ origin: 'peer' })
                            │
                            ▼
                    timelineMaterializer.onAccepted
                            │
                            ▼
                    _BAC/timeline/projections/<YYYY-MM-DD>.json
                            │
                            ▼
            GET /v1/timeline?since=&until=&q=&limit=
                            │
                            ▼
                    plugin extendedQuery → ScopedResult
```

## Event model

`browser.timeline.observed` event:

```ts
interface BrowserTimelineObservedPayload {
  readonly eventId: string;          // stable per emission
  readonly observedAt: string;       // ISO timestamp
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly provider?: 'chatgpt' | 'claude' | 'gemini' | 'generic';
  readonly transition: 'activated' | 'updated' | 'completed' | 'closed';
  readonly tabIdHash?: string;
  readonly windowIdHash?: string;
}
```

`eventId` is plugin-generated and content-derived (tabIdHash +
canonicalUrl + observedAt window). It is the de-duplication key
within the plugin before emission; `clientEventId` for `appendClient*`
on the companion derives from it.

The aggregate id for the projection is the **day bucket**
(`YYYY-MM-DD`), since the projection files are daily.

## Projection shape

```ts
interface TimelineEntry {
  readonly id: string;             // canonicalUrl-derived stable id within bucket
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly provider?: string;
  readonly visitCount: number;     // number of distinct activate/update events
}

interface TimelineDayProjection {
  readonly date: string;           // YYYY-MM-DD (UTC)
  readonly entries: readonly TimelineEntry[];
  readonly updatedAt: string;
  readonly entryCount: number;
}
```

The projection is **deterministic** from the event log. The reducer:

1. Groups events by `canonicalUrl` (or raw `url` if no
   canonicalization).
2. For each group, computes `firstSeenAt` = min, `lastSeenAt` = max,
   `visitCount` = count of `activated`/`updated` transitions.
3. Sorts by `lastSeenAt` desc within the day.

`closed` and `completed` transitions don't change `visitCount` — they
update `lastSeenAt` for session-end accuracy.

## Debounce + coalescing

The chrome tabs APIs fire frequently:

- `onActivated` — every tab switch, including alt-tab during a long
  read.
- `onUpdated` — multiple times per navigation (loading, complete) and
  on title changes.

The observer applies these rules:

1. **Same tab + same canonical URL within 30 s** → coalesce. Update
   `lastSeenAt` on the existing in-memory entry; emit an event ONLY
   on the first observation for that (tab, canonicalUrl) within the
   window.
2. **Title change on the same canonical URL** → update in-memory; do
   NOT emit a new event for a title-only change.
3. **Navigation (canonical URL changes)** → emit a new
   `browser.timeline.observed` with `transition: 'activated'` (or
   `'updated'` if the previous URL hadn't been observed).
4. **Tab close** → emit `transition: 'closed'` for the last observed
   URL of that tab.

Coalescing keeps emission rate to roughly one event per
(tab, distinct canonical URL, 30-second window) — bounded enough to
fit comfortably within the spool budget.

## ResultScope

Plugin local query against the active window:

- Active window covers it → `plugin-active`.
- Active window only and user asked for a wider range → 
  `plugin-active-only-companion-unreachable` (Mode P) or
  `companion-extended` (Mode P+C).
- Some range is in exported archives the companion hasn't imported →
  `archive-exported-not-imported`.

Plugin renders the `note` from `buildScopedResult(scope, items)` so
the user knows which slice of history they're looking at.

## Health surfaces

**Plugin** (`PLUGIN_HEALTH_SNAPSHOTS` registry entry):

```ts
{
  name: 'timeline',
  status: 'healthy' | 'degraded' | 'failed',
  activeSetSize: number,
  activeSetBudget: number,
  spoolSize: number,
  spoolBudget: number,
  companionReachable: boolean,
  lastObservedAt: string | null,
  failedExplicitCount: 0,           // timeline is passive-only
  droppedPassiveCount: number,      // bumped on spool overflow
  lastError: string | null,
}
```

**Companion** (`/v1/system/health`):

```json
{
  "sync": {
    "materializers": {
      "timeline": {
        "status": "healthy",
        "lastSuccessAt": "...",
        "lastError": null,
        "pending": false
      }
    }
  }
}
```

## Test plan

Unit (vitest):

- Observer coalesce / debounce per the rules above.
- Projection reducer determinism — same events produce the same
  projection regardless of order.
- Plugin materializer active overflow → spool transition.
- Passive overflow → `dropped-passive-by-policy` + counter.
- Spool drain idempotent on edge dot.
- Registry coverage: `browser.timeline.observed` has exactly one
  entry; surfaces declare the correct classes.

Contract (vitest):

- Mode P offline: observations record locally; active bounded;
  passive overflow drops with counter.
- Mode P+C reconnect: spool drains to companion; companion projection
  has entries.
- Mode P+C+R: peer companion receives event and projection catches
  up.
- ResultScope: every cross-window query returns honest scope.

E2E (playwright, minimal):

- Plugin observes synthetic tab changes (use an injectable observer
  adapter so we don't depend on real chrome.tabs in CI).
- Companion offline → active timeline has recent entries.
- Companion starts → spool drains.
- `GET /v1/timeline` returns the drained entries.

If real browser tab APIs are flaky in Playwright, the observer is
injected with a synthetic adapter and tested separately. The Class F
admit/spool/drain path is the primary thing to e2e.

## Acceptance criteria

The follow-up PR is done when:

1. `browser.timeline.observed` is in the contract registry.
2. Plugin timeline materializer uses Class F active/spool budgeting.
3. Timeline observations do not grow `chrome.storage` unbounded.
4. Passive overflow is health-visible (`droppedPassiveCount`).
5. Companion can import + drain timeline events.
6. Companion projects timeline entries deterministically.
7. `GET /v1/timeline` returns entries with honest `ResultScope`.
8. Tests cover Mode P and Mode P+C end-to-end.
9. Future-surface integration test still passes.
10. Docs explain the feature and privacy boundaries.

## Out of scope

Explicitly NOT in this PR:

- Screenshots / page body / OCR.
- Polished side-panel timeline UI.
- Full semantic search over timeline (this would be a Class B index;
  not needed yet).
- Timeline summarization (extraction layer, future).
- Cross-device conflict UI for timeline.
- User-tunable budget UI.
- File-export archive trigger via chrome.downloads (inherits
  whatever Class F provides; no timeline-specific export wiring).
- An explicit on/off toggle (default-on; toggle is a follow-up).

The architecture leaves room for these. The point of this PR is to
prove the contract is open without changing it.

## Pointers

Code (added by the timeline PR — see commit list):

- `packages/sidetrack-companion/src/timeline/events.ts` — event type
  + payload + predicate.
- `packages/sidetrack-companion/src/timeline/projection.ts` — daily
  bucket reducer + on-disk store.
- `packages/sidetrack-companion/src/sync/contract/timelineMaterializer.ts`
  — Class A materializer.
- `packages/sidetrack-extension/src/timeline/events.ts` — plugin-side
  event constants.
- `packages/sidetrack-extension/src/timeline/observer.ts` — chrome
  tabs adapter + debounce.
- `packages/sidetrack-extension/src/timeline/materializer.ts` —
  PluginMaterializer<TimelineEntry>.

Registry entry: `packages/sidetrack-companion/src/sync/contract/registry.ts`.
HTTP endpoint: `GET /v1/timeline` in
`packages/sidetrack-companion/src/http/server.ts`.
