# Stage 5.0 retrospective — what shipped in PR #141

> **Closing-out document for PR #141** (`feat/work-graph-stage5-data-bridge`).
> Companion to [`work-graph-stage5-data-bridge.md`](work-graph-stage5-data-bridge.md),
> which holds the original Stage 5.0 plan and the still-scope-locked
> Stage 5.1 (T7a–T7d). This doc records what actually shipped, what
> drifted from plan, what slipped to Stage 5.2 / 5.M, and the costed
> follow-up list.

## Scope of PR #141

Stage 5.0's original scope: tracks **T1–T6**, the data-bridge closures.
Six commits implement those tracks directly. The remaining ~40 commits
on the branch are emergent fixes — bugs surfaced *because* the bridge
was finally on and producing observable data. The PR shipped both the
planned closures and the emergent stabilization work as one bundle on
purpose: the planned closures are not testable without the
stabilization fixes (the recorder couldn't run long enough to produce
the engagement-eligible counters T1 was designed to report).

## In-scope tracks — closure status

| Track | Status | Evidence |
|---|---|---|
| **T1 — Materializer diagnostics** | ✅ shipped | `_BAC/connections/diagnostics/latest.json` populated; per-source URL attribution breakdown; engagement counters; ranker `newLabelCount` field added late in the cycle. |
| **T2 — Similarity gates + lexical fallback** | ✅ shipped | Env knobs: `SIDETRACK_SIMILARITY_THRESHOLD`, `SIDETRACK_SIMILARITY_LEXICAL_THRESHOLD`, `SIDETRACK_SIMILARITY_LEXICAL_FALLBACK`. Effective config now reported in diagnostics. |
| **T3 — Topics from user assertions** | ✅ shipped | `userAssertedRelations` derived from `user.organized.item` events; topic clusterer bypasses engagement gate for user-asserted relations. |
| **T4 — Ranker label-shape conversion** | ✅ shipped | `deriveVisitPairLabelsFromSnapshot` + `augmentFeedbackWithVisitPairLabels` produce `(visit, visit)` pairs from URL→workstream attributions. |
| **T5 — `timeline_same_url_as_thread` demotion** | ✅ shipped | Gate on `(provider match OR title-Jaccard ≥ 0.25) AND recency ≤ 24h`; `metadata.evidence` blob records which gates fired. |
| **T6 — Preserve dormant `tab_session_in_workstream`** | ✅ shipped | `docs/architecture.md` documents dormancy; T1 diagnostics report `tabSessionAttributionInferredCount` so dormant ≠ broken. |

All six tracks landed against the acceptance bars from the original
plan. Verification followed the doc's "Verification (Stage 5.0
acceptance)" section — counters in `latest.json`, not "the code runs."

## Emergent track — engagement subsystem rebuild

The single biggest piece of work *not* in the original plan. Surfaced
during T1 dogfooding when the engagement counters stayed at zero
indefinitely despite the recorder running for hours. Root-cause hunt
walked through the full chain:

1. **Privacy gate** — `engagement` gate was never opened in production
   (only test scripts wrote `privacy.gate.flipped{gate:'engagement'}`).
   Auto-open on host-permission grant added.
   (`fb3657c2`)
2. **Content-script registration** — `chrome.scripting.registerContentScripts`
   only injects on FUTURE navigations; already-open tabs needed
   explicit `executeScript`. Added catch-up reinject path.
   (`fb3657c2`, `9a295dda`)
3. **EventId-length truncation** — long URLs (Google search query
   strings) produced `clientEventId` strings > 256 chars; companion
   rejected them as `invalid-payload`. Hashed the URL component with
   FNV-1a32 to bound length.
   (`1cc9c1a8`)
4. **Drain alarm missing** — `drainBufferedEdgeEvents` had exactly one
   caller (a test-only message). No periodic alarm. Engagement events
   accumulated in IndexedDB forever. Added 1-minute alarm + eager boot
   drain + drain-on-tab-close.
   (`fb3657c2`)
5. **`/v1/edge/events` route missing** — the most load-bearing finding.
   The companion's plan-comment ("a future generic `/v1/edge/events`
   router would be a separate route") was never implemented. The
   plugin POSTed to that route for 3 weeks and got 404 every time.
   Engagement events stuck in IndexedDB across the entire dogfood
   period. Route shipped with `edgeEventsRoute.test.ts` as a
   regression pin.
   (`449b3ea1`, `9f628092`)
6. **Permanent eviction for unknown event types** — Codex's pass.
   Stale `navigation.committed` events from older builds were
   accumulating in the SW buffer; the drain now classifies
   `invalid-event-type` and `invalid-payload` as permanent rejection
   and evicts.
   (`709f7c9d`, `5b2f30c8`, `9a2d4816`)

**Outcome:** engagement.session.aggregated counter now climbs in
dogfood (verified via CDP probe: 0 → 3+ after a single HN session).
Similarity edges, URL inference, and ranker negatives are unblocked.

## Emergent track — side-panel UX stabilization

Bursty event ingest + the side panel's polling pattern interacted in
ways that the Stage 5.0 plan did not anticipate.

| Issue | Fix | Commits |
|---|---|---|
| Inbox flicker / red banner during polls | Hide loading line once any projection has loaded; gate suggestion fetch on a single-flight ref | `7d55d0da`, `914f2624` |
| Current-tab card stuck on "(capturing…)" | Live `chrome.tabs` subscription + sequenced `force-drain → 150ms settle → loadTabSessions` | `9a295dda`, `6bedafa3` |
| `ERR_INSUFFICIENT_RESOURCES` from per-row fetches | Module-level semaphore (`acquireCompanionFetchSlot`, cap 4 in-flight) with slot-transfer release | `2500f63f`, `83098f43` |
| Side panel rendering itself as "Current tab" | Filter non-trackable schemes from `liveActiveTabUrl` | `18f68482` |
| Companion-disconnected flashes | Cache `/v1/visits/projection` + `/v1/tabsessions/projection` with single-flight + 500 ms TTL | `3721deb6`, `e03ee4bb` |
| Timeline drain orphans | Drain retries `pending-send` entries (was filtered out) | `d819a86d` |

The semaphore + slot-transfer pattern is the load-bearing piece — it
keeps Chrome's per-origin socket pool from exhausting and the
companion's HTTP loop responsive enough for the periodic health probe
to get through.

## Emergent track — debug infrastructure

Driven by the user's explicit critique mid-arc ("Stop asking the user
to manually retry/reload as the primary debug loop").

- **attach-diag** — Playwright-driven `chromium.connectOverCDP` harness
  that spawns an ephemeral companion, opens privacy gates, navigates,
  and writes a JSON evidence block per-condition-classified.
  (`6fef18d2`, `a9e3fed9`, `81aa4e98`)
- **Recorder CDP attach** — `SIDETRACK_E2E_CDP_DEBUG_PORT=9223` opens
  port for `chromium.connectOverCDP` against a live recorder session.
  Sequential allocation so the two recorder browsers don't fight over
  one port. (`83098f43`, `8c277376`)
- **`sidetrackDebug` global on the SW** — readable from the SW
  DevTools console; exposes `drainEdgeEvents`, `engagementGate`,
  `engagementRegistrations`. (`2b926e24`)
- **Diagnostic scripts** — `inspect-current-tab.mjs`,
  `diagnose-yc-jobs.mjs`, `force-drain-and-check.mjs`,
  `engagement-end-to-end.mjs`, `observe-recorder-state.mjs`,
  `inspect-companion-status.mjs`. All run against the recorder's CDP
  port; each is the template for one diagnosis class.

These pieces collapsed the ~20-minute "ask user to paste DevTools
output" turnaround into a ~20-second `node scripts/<probe>.mjs` cycle.

## Documentation

- `standards/03-ts-browser-plugin.md` §"Debugging-pit best practices"
  — nine lessons from the engagement arc, each paired with the
  symptom it produces. New agents inheriting this codebase read this
  before touching anything.
- `docs/architecture.md` §"Stage 5 — close the data bridge" — env
  knobs, demoted edges, attach-diag.
- `packages/sidetrack-companion/src/http/edgeEventsRoute.test.ts` —
  regression pin for the missing-route class of bug.

## Test counts (before vs after PR #141)

| Suite | Before | After | Delta |
|---|---|---|---|
| Companion unit (`sidetrack-companion`) | ~895 | 914 | +19 |
| Extension unit (`sidetrack-extension/tests/unit`) | 532 | 537 | +5 |
| Total | ~1427 | 1451 | +24 |

New tests pin: `/v1/edge/events` route contract; edge-event drain
permanent eviction + single-flight; URL projection cache (six
behaviours); tab-session projection cache (five behaviours); timeline
spool pending-send orphan retry; entity display format helpers.

## Drift from plan

Items the plan called out as in-scope but that shipped differently:

- **T1 diagnostics expanded** mid-flight to include `newLabelCount`,
  `attributionBySource`, engagement counters, ranker skip reason
  surfacing. The diagnostic schema is richer than the plan specified.
  Defensible — the original schema didn't surface enough to explain
  ranker `skipped:below-threshold` to the operator.
- **T4 ranker** still reports `negativeLabelCount: 0` in live runs.
  Label-shape conversion landed, but the negative-label path (visit
  pairs rejected by the user, dismissed inbox cards) doesn't have a
  user-action surface that produces enough negative training data
  yet. Not a bug — a UX-coverage gap. Carried into Stage 5.1 sequencing.
- **`SIDETRACK_TIMELINE_STRIP_MARKETING_PARAMS` per-site overrides**
  were marked as a Stage 5.1 follow-up in `docs/architecture.md`. Not
  shipped in this PR. Still deferred.

## Open follow-ups (not blocking Stage 5.0 merge)

1. **`/v1/system/health` directorySize cost** — recursive walk of the
   vault tree adds 200–500 ms per call. Cache the size or compute
   incrementally. Small win, easy fix; Stage 5.1 nice-to-have.
2. **Inbox pagination UI** — companion API already supports
   `limit`/`offset` (default 50, max 200). Side panel's "next page"
   button doesn't exist yet. UI-only change.
3. **Thread → URL attribution propagation in `/v1/visits/projection`** —
   the materializer's internal projection passes `{threads}` so
   thread-derived attributions populate `byCanonicalUrl`, but the HTTP
   route at `server.ts:1706` doesn't. Side panel never sees the
   thread-derived attribution. ~10-line fix; see Stage 5.M for why
   this is better folded into the materializer refactor.
4. **URL inference + ranker negative labels** — counters stay at zero
   because no production code path invokes
   `POST /v1/visits/{url}/resolve dryRun:false`. Route + producer
   exist; caller needs wiring. Either a companion-side scheduler or
   side-panel suggestion-accept trigger. Sequencing: pair with
   Stage 5.1 / T7a (content evidence will be a useful candidate
   source for the resolver).
5. **CI safety net** — `connections-full-browser-sync-user-story.spec.ts`
   contains a `drainEdgeEvents` assertion that would have caught the
   missing `/v1/edge/events` route months ago. No `.github/`
   workflows checked in to this repo; CI provenance unconfirmed.

## Why merge now

The bar from the original plan was:

> Stage 5 closes that bridge without changing the architecture.

The bridge is closed:

- Engagement events flow client → SW buffer → companion → materializer
  → snapshot. Verified end-to-end via CDP attach (`449b3ea1`).
- Similarity, topics, URL inference are unblocked structurally.
  Recipe-style counters still need user-traffic accumulation to climb.
- Diagnostic surface exposes the entire pipeline; "the code runs but
  the counters are zero" is now a fixable condition with traceable
  evidence, not a mystery.

What hasn't changed: the architectural locks from the northern star
hold. No GPU dependencies added. No off-device pipelines. User
organization remains authoritative. Snapshot byte-determinism
preserved.

## Lessons folded into standards/03-ts-browser-plugin.md

Nine pitfalls from the engagement arc are pinned in
`standards/03-ts-browser-plugin.md` §"Debugging-pit best practices":

1. Plan-comments are not route implementations.
2. `chrome.runtime.sendMessage` from SW DevTools is a no-op.
3. `chrome.storage.local` writes from SW listeners are unreliable on Chrome 148+.
4. Per-row `useEffect` fetches don't scale.
5. Manifest version must encode build time.
6. Recorder must be CDP-attachable on demand.
7. Fold diag journals into `sidetrack.dev.diag` dumps.
8. `registerContentScripts` only injects on FUTURE navigations.
9. Privacy gates are state, not consent.

New agents inheriting Stage 5.x branches should read this section
before any non-trivial change. Each rule is paired with the symptom
it produces, so pattern-matching catches the recurrence before the
investigation cost.
