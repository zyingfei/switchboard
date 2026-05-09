# T1 Wave 2 — Coding-agent handoff prompt

You are picking up Wave 2 of the **T1 record / replay / evaluate**
testing-infrastructure track for Sidetrack (the
`browser-ai-companion` repo). Wave 1 (the charter) has already
landed. Your job is to implement Wave 2 in four vertical slices —
2a, then 2b, then 2c, then 2d — each as its own PR.

This prompt is paste-ready: read it plus the linked references and
start without any prior conversation context.

## Required reading (in order)

1. [`docs/testing/T1-record-replay/CHARTER.md`](./CHARTER.md) — the
   design contract. **Load-bearing.** It freezes the `SessionPack`
   v1 schema, the privacy contract (three capture levels), the
   five-layer replay contract, the evaluation contract (detours
   first-class, qualitative warnings), and what is in / out of v1.
   Do not re-litigate these decisions.
2. [`docs/testing/T1-record-replay/README.md`](./README.md) —
   sequencing and done criteria.
3. [`AGENTS.md`](../../../AGENTS.md) — universal repo conventions.
4. [`CODING_STANDARDS.md`](../../../CODING_STANDARDS.md) — the
   non-negotiable code-quality bar. Pay particular attention to
   "POC-to-product conversion" and "Documentation required per
   feature."
5. The existing manual two-browser harness spec under the
   extension package's `tests/e2e/` directory — Wave 2 reuses its
   scaffolding pattern (relay + 2 companions + 2 extension
   runtimes, hangs forever for inspection).
6. The existing real-tab e2e specs in the same directory — they
   are the canonical example of driving `chrome.tabs` navigations
   with `page.route()` stubs, force-draining the companion via the
   existing runtime message, and asserting against `/v1/timeline`
   and `/v1/connections`. Wave 2 replay must follow this pattern.

You do not have to find files in advance — find them as you go.
This prompt deliberately avoids file paths and line numbers because
they drift.

## Slice plan — three PRs

### Wave 2a — One-browser record/replay vertical slice

Branch `t1/record-replay-2a`. Goal: smallest end-to-end loop.

- **Record** a single-browser session (one companion, no relay) at
  `captureLevel: "minimal"`. Capture URLs (sanitized at record-time
  via the existing timeline URL sanitizer), titles,
  navigation/focus/tab events, workstream switches. **No HTML, no
  paste content** at this slice.
- **Replay** the pack: drive `chrome.tabs` navigations against
  route stubs derived from the pack, write the recorded
  `activeWorkstreamId` into
  `chrome.storage.local['sidetrack.activeWorkstreamId']` at the
  recorded times, force-drain the companion, read `/v1/timeline`
  and `/v1/connections`. **Do not** seed `/v1/timeline/events`
  directly — the existing spec discipline applies.
- **Evaluate** the run across the five replay layers from the
  charter (page replay → extension observation → companion
  projection → graph materialization → evaluation expectations).
  Emit a markdown report and a JSON sidecar to a per-run folder
  under the session pack directory.
- **Storage** at `~/.sidetrack/test-sessions/`, env override
  `SIDETRACK_TEST_SESSIONS_DIR`. Add a defensive `.gitignore` entry
  for any repo-relative override.
- **Specs** run only under a `manual` Playwright project — never
  on default CI. (If no `manual` project exists yet, register one
  the same way the existing manual two-browser spec is excluded
  from CI.)
- **Privacy hard line.** The recorder must assert on shutdown that
  the pack contains no values from `chrome.storage.local` keys
  other than `sidetrack.activeWorkstreamId`, no `document.cookie`
  content, and no auth headers. A deny-list match fails the
  recording rather than writing it.

### Wave 2b — Two-browser relay replay

Branch `t1/record-replay-2b`. Builds directly on 2a's helpers.

- Extend record to two browsers (Browser A active + Browser B
  review) reusing the existing two-browser-harness scaffolding
  pattern.
- Replay drives both browsers through stubbed routes; the relay is
  the existing test relay. After replay, Browser B's Connections
  must render the expected nodes/edges from Browser A's recorded
  activity.
- Add `SIDETRACK_REPLAY_HOLD=1`: when set, both windows stay open
  after the evaluator finishes so the user can inspect Connections
  / Why Related / Feedback UI by hand. The report records that the
  held URLs are reachable.
- Add **`captureLevel: "html"`** as an opt-in flag. HTML snapshots
  per visit must run through the existing companion-side redaction
  helper at record-time, with `redactionCounts` stamped onto the
  snapshot. HTML stays local-only.

### Wave 2c — Detour classification, qualitative warnings, graph-quality scoring, polish

Branch `t1/record-replay-2c`. Closes the brief's R16 and R18.

- **First-class detour classifier** with the kinds named in
  `CHARTER.md §5`: `cloudflare-challenge`, `login-wall`,
  `sso-redirect`, `consent-page`, `provider-interstitial`,
  `not-found-403-404`, `provider-unavailable`. Detection is
  URL-pattern + title-heuristic only — no DOM scraping required.
- **Detour assertions** (per the charter): detour did not pollute
  workstream topics, did not become a strong similarity anchor,
  did not replace the original target `canonicalUrl`, every detour
  is listed in the report.
- **Qualitative warnings** (presence-based, no scoring): the six
  warnings in `CHARTER.md §5`. A warning is yellow, not red.
- **Graph-quality scores (R18)** as defined in `CHARTER.md §5` —
  six 0–1 scores with rationale: topic purity, ambient containment,
  causal coherence, search→result→chat continuity, false-similarity
  rate, ranking plausibility. Each score reads from the data
  already in the pack and the projections (`/v1/timeline`,
  `/v1/connections`); none requires new instrumentation. Thresholds
  are advisory in v1: they shift the report color (green / yellow
  / red) but do not turn warnings into hard fails.
- Add **`captureLevel: "html+paste"`** — when set, every `copy` /
  `paste` event carries the **raw `content`** along with its
  `contentHash` (SHA-256) and `length`. Replay fidelity needs the
  exact bytes; the pack is local-only and never committed. Both
  HTML and paste are gated behind explicit flags; HTML is **not**
  the default. Password *fields* are still excluded.
- Report polish: the markdown report is human-readable and starts
  with the score table; the JSON sidecar contains the same
  structured data plus a `scores` block, and diffs cleanly between
  runs.

### Wave 2d — `sidetrack-test` CLI

Branch `t1/record-replay-2d`. Builds on 2a/2b/2c.

- Ship a small CLI under the existing `packages/` layout (pick a
  package name like `sidetrack-test-rr` or extend an existing
  testing package — your call). The CLI is a **thin shell** over
  the manual Playwright specs from the earlier slices; it does
  not introduce new storage paths, schemas, or runtime paths.
- Implement the subcommand surface from `CHARTER.md §6`:
  `record`, `replay`, `report`, `list`, `inspect`. Flag names are
  illustrative in the charter — pick clean ones that map directly
  to `mode.browsers`, `mode.captureLevel`, and
  `SIDETRACK_REPLAY_HOLD`.
- Each subcommand maps onto: spawn the right Playwright spec with
  the right env vars, surface the resulting pack/report path, and
  exit with a meaningful status code (0 for green, non-zero for
  red — yellow is 0).
- The CLI must respect `SIDETRACK_TEST_SESSIONS_DIR`. It must not
  reach into a pack's HTML or paste content beyond what `inspect`
  explicitly prints (metadata only — no event bodies, no HTML).
- No daemon, no background processes, no privileged file access
  outside `SIDETRACK_TEST_SESSIONS_DIR`.

## Reuse expectations

Find and reuse these existing surfaces — do not reimplement:

- the manual two-browser interactive harness spec (record-mode
  scaffolding pattern),
- the existing test helpers for spinning up companion / relay /
  extension runtimes / sidepanel seeding,
- the route-stub + force-drain pattern from the existing real-tab
  e2e specs,
- the timeline URL sanitizer (URL scrubbing at record-time),
- the companion-side redaction helper (HTML scrubbing at
  record-time),
- the `/v1/timeline` projection read and `/v1/connections` graph
  snapshot endpoint (evaluation surfaces),
- the Sync Contract v1 `payloadVersion` versioning pattern (apply
  to the pack's `schemaVersion`),
- `chrome.storage.local['sidetrack.activeWorkstreamId']` as the
  single source of truth for active-workstream stamping during
  both record and replay.

If you find a tempting near-fit utility, prefer to extend it
behind its existing API rather than fork a copy.

## Privacy hard rules (apply across all slices)

These come from `CHARTER.md §3` and are non-negotiable:

- **Never captured**: cookies, localStorage, sessionStorage, auth
  headers, password field values, raw provider tokens, full
  browser profiles, screenshots.
- Default `captureLevel` is `"minimal"`. `"html"` and `"html+paste"`
  require explicit per-run flags whose names you may choose.
- At `"html+paste"`, copy/paste content is stored **raw** alongside
  its SHA-256 hash and byte length; the pack stays local-only.
- HTML snapshots always carry `redactionCounts`.
- Hashing uses **SHA-256** (Node built-in `crypto`), not FNV.
- Storage lives under `~/.sidetrack/test-sessions/`; never in the
  repo. Pick a `.gitignore` entry that defends against
  repo-relative overrides.

## Acceptance per slice

### Wave 2a

```
SIDETRACK_TEST_SESSIONS_DIR=/tmp/t1-smoke \
  npx playwright test \
  packages/sidetrack-extension/tests/e2e/<your-record-spec> \
  --headed --timeout 0 --grep manual
```

1. Replay drives navigations through `chrome.tabs` (no direct
   `/v1/timeline/events` seeding).
2. The report has explicit pass/fail for all five replay layers.
3. `/v1/timeline` after replay matches the recorded canonical-URL
   set, modulo any pre-classified detours from `expectations`.
4. The full unit + e2e suite still passes; the new specs run only
   under the `manual` Playwright project.

### Wave 2b

5. Browser B's Connections panel renders with the expected
   nodes/edges from Browser A's recorded activity (visual
   confirmation with `SIDETRACK_REPLAY_HOLD=1`; the report records
   that the held URLs are reachable).
6. `captureLevel: "html"` round-trips: a recorded snapshot's
   `redactionCounts` is non-empty whenever any rule fires; HTML is
   restored intact at replay (modulo redactions).

### Wave 2c

7. Each detour kind is detected on a constructed pack containing
   it.
8. Each qualitative warning fires on a constructed pack designed
   to trip it.
9. Each of the six graph-quality scores returns a stable value on
   a constructed pack and its rationale string is non-empty.
10. The markdown report opens with the score table; the JSON
    sidecar carries a `scores` block and diffs cleanly between
    runs.

### Wave 2d

11. `sidetrack-test record` launches the right manual spec, prints
    the pack path on Ctrl-C, and respects
    `SIDETRACK_TEST_SESSIONS_DIR`.
12. `sidetrack-test replay <pack>` runs the replay, prints the
    report path, and exits 0 on green / yellow and non-zero on
    red.
13. `sidetrack-test report <run>` and `list` and `inspect` produce
    the output described in `CHARTER.md §6` and never print event
    bodies or HTML.

### Privacy verification (every slice)

- `grep` for `document.cookie` in the new helpers returns nothing.
- A recorded `pack.json` contains no values from
  `chrome.storage.local` keys other than `sidetrack.activeWorkstreamId`.
- `htmlRedacted` strings carry `redactionCounts`.
- Default `captureLevel === "minimal"`; richer levels require the
  explicit per-run flag.
- Recorder asserts deny-list on shutdown.

## What is *not* on the table for v1

Do not implement these in any of the four slices. They are
reserved for follow-up waves:

- Live-mode replay (live or mixed). v1 is stubbed-only; the
  schema's `mode` field is forward-compatible.
- Screenshots.
- CI gating.
- Cross-pack diffing UI.
- Promoting a recorded pack to a committed sanitized fixture.

If during implementation you find a strong reason to expand v1
scope, raise it as a comment on the Wave 2 PR rather than just
shipping it.

## Done criteria for the whole of Wave 2

- 2a, 2b, 2c, 2d each merge as separate PRs.
- The full unit + e2e suite is green on each PR; the new specs run
  only under the `manual` Playwright project.
- Every privacy verification above passes on every PR.
- A real recorded pack from the user's own browsing replays
  successfully via `sidetrack-test replay <pack>` and produces a
  report the user can read.
