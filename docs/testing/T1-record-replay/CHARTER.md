# T1 Charter — Local user-session validation harness

**Status**: Wave 1 design contract (no implementation yet)
**Track**: Testing infrastructure (T1)
**Date**: 2026-05-09

This charter is the design contract Wave 2 must satisfy. It does
not name files, helper APIs, or implementation choices beyond the
frozen `SessionPack` v1 schema and the CLI surface in §6.

## Vocabulary

Use these terms consistently. Avoid "training data" — nothing here
is being trained.

- **local session pack** — the on-disk artifact a recording produces.
- **recorded user workflow** — the sequence of real-user actions a
  pack captures.
- **replay fixture** — a session pack used as input to a deterministic
  replay run.
- **evaluation baseline** — the report (markdown + JSON sidecar) a
  replay run produces; subsequent runs diff against prior baselines.

---

## 1. Problem after PR #109/#110

PR #109/#110 lands the deterministic L5 spec: real-shaped URLs with
route stubs, two browsers + two companions + relay, and the explicit
discipline that the spec must drive `chrome.tabs` rather than seed
`/v1/timeline/events` directly. That is the regression floor and
should stay merge-blocking.

It deliberately sidesteps real-user surprises, because real
network/login/Cloudflare/SSO state is not deterministic enough for
CI:

- login walls and SSO redirects on Google / GitHub / providers,
- Cloudflare and bot-check challenges,
- consent pages and provider-side interstitials,
- SPAs whose canonical URL changes mid-session,
- copy/paste flows between research tabs and AI agents,
- ambient tabs (YouTube, music, docs) that should not pollute the
  active workstream,
- workstream switches mid-flow, both explicit and forgotten.

Adding more L5 specs will not close the gap — every new surprise
has to be transcribed by hand into a fixture, which is exactly the
cost real users keep paying. Pure manual live testing also fails:
each run depends on transient login/network state, and the same
surprise is hard to reproduce later.

The right shape is **record once, replay many**: the user records a
real workflow once, and the system replays it locally — against the
same browser/extension/companion/relay code paths a real user
drives — as often as needed to validate product changes.

This charter scopes that record / replay / evaluate harness.

## 2. Record → replay → evaluate cycles

The brief defines five cycles. They form a state machine over a
single pack.

```
   ┌──────── Cycle A: fresh recording
   │
   ▼
[ pack ]──── Cycle B: save / sanitize / annotate expectations
   │
   ▼
[ replay run ]──── Cycle C: replay in a chosen mode
   │
   ▼
[ evaluation baseline ]──── Cycle D: hold windows open, inspect
   │
   ▼
[ product change ]──── Cycle E: replay again, diff baselines
```

Runtime surfaces each cycle touches (named by symbol/pattern, not
file line):

- **Cycle A — record.** Drives a real or test browser; the timeline
  observer at extension boot fires on `chrome.tabs` events; the
  companion ingests through its existing `/v1/events` and
  `/v1/timeline/events` endpoints; `/v1/connections` materializes the
  graph. The recorder *observes* these as a passive listener — it
  does not seed them.
- **Cycle B — save.** The pack is sanitized at write-time
  (URL sanitizer, redaction helper for HTML, hashing for paste);
  expectations are an optional, hand-edited block (`expectedCanonicalUrls`,
  `knownDetours`, qualitative warnings the user wants asserted).
- **Cycle C — replay.** Drives `chrome.tabs` navigations against
  route stubs constructed from the pack's recorded snapshots; writes
  the recorded `activeWorkstreamId` into
  `chrome.storage.local['sidetrack.activeWorkstreamId']` at the
  recorded times; force-drains the companion via the existing
  runtime message; reads back `/v1/timeline` and `/v1/connections`.
  Replay never seeds `/v1/timeline/events` directly.
- **Cycle D — inspect.** When the run is held open, the user opens
  Browser B's Connections panel and exercises Why Related / feedback
  / dispatch by hand. The held URLs are recorded into the report.
- **Cycle E — diff.** A second replay against the same pack on a
  later commit produces a second baseline; the JSON sidecars diff
  cleanly to surface regressions.

## 3. Privacy contract

Three capture levels. The default is the most restrictive. Richer
levels require an explicit per-run flag.

| Level | URLs + titles + events | HTML snapshot | Copy / paste |
|---|---|---|---|
| `minimal` *(default)* | yes (URL-sanitized at record-time) | no | no |
| `html` *(opt-in)* | yes | yes, redacted, with `redactionCounts` | no |
| `html+paste` *(explicit flag)* | yes | yes, redacted | **raw content** (with SHA-256 hash + length alongside) |

URLs are sanitized through the existing timeline URL sanitizer
before they enter the pack. HTML is sanitized through the existing
companion-side redaction helper, with the per-rule `redactionCounts`
stamped onto the snapshot so a silently-failing pipeline is visible.

**Copy/paste content is stored raw** at the `html+paste` level.
Replay fidelity needs the exact bytes — the causal edge between a
source page and the chat thread the snippet ends up in only
reconstructs correctly when the same content is re-pasted. Packs
live local-only under `~/.sidetrack/test-sessions/` and are never
committed; the user owns the data the user typed. The `contentHash`
and `length` fields stay alongside the raw content so the pack can
still be referenced and diffed by hash.

**Never captured, regardless of level**: cookies, localStorage,
sessionStorage, auth headers, password field values, raw provider
tokens, full browser profiles, screenshots. The recorder asserts
this deny-list on shutdown — any value matching it fails the
recording rather than writing it. Note the deny-list does not
include user-typed paste content; password *fields* are still
excluded.

**Storage** is local-only:
`~/.sidetrack/test-sessions/` by default, env override
`SIDETRACK_TEST_SESSIONS_DIR`. Repo-relative overrides are covered
by a defensive `.gitignore` entry. Packs themselves never live in
the repo.

**Hashing** uses SHA-256 (Node built-in crypto). Collision
resistance matters once packs are referenced by content hash.

## 4. Replay contract — five layers, each pass/fail independently

A replay run reports on these five layers in order. A failure must
name which layer broke; the report lists per-layer status so
`page-replay green / observation red / projection green` is
unambiguous.

1. **Page replay.** Did the recorded navigations succeed against
   the route stubs? Misses here mean the stub map is broken.
2. **Extension observation.** Did the timeline observer fire on
   each navigation? Misses here mean the observer is not wired
   correctly for the replayed transition kinds.
3. **Companion projection.** Did `/v1/timeline` reflect the
   visits after force-drain? Misses here mean the
   plugin→companion path lost events.
4. **Graph materialization.** Did `/v1/connections` expose the
   expected nodes and edges (`visit_in_workstream`, same-tab
   navigation, opener, cross-replica, dispatch-in-workstream,
   dispatch-requested-coding-session)? Misses here mean the
   ranker / projection reducers regressed.
5. **Evaluation expectations.** Did the user-asserted
   `expectedCanonicalUrls`, `knownDetours`, and qualitative
   warnings hold? Misses here may be product regressions OR stale
   expectations — the report distinguishes them.

## 5. Evaluation contract — detours first-class, qualitative warnings supported

**Detours are first-class**, not edge cases. The classifier
recognizes:

- `cloudflare-challenge`
- `login-wall`
- `sso-redirect`
- `consent-page`
- `provider-interstitial` *(YouTube/Gemini pre-auth, etc.)*
- `not-found-403-404`
- `provider-unavailable`

For each detour the evaluator asserts:

- the detour did not pollute workstream topics,
- the detour did not become a strong similarity anchor in the
  Connections graph,
- the detour did not replace the original target `canonicalUrl`,
- every detour observed is listed in the report.

**Qualitative warnings** are presence-based, not scored. v1 ships:

- many pages assigned to the same workstream after a long idle,
- a Cloudflare/login page became a topic source,
- copy/paste observed but no dispatch / coding-session edge
  followed,
- YouTube / ambient page attached to wrong workstream,
- a single canonical URL produced multiple visit nodes,
- expected tab lineage missing.

A warning is a yellow flag in the report, not a fail.

**Graph-quality scoring (R18).** v1 also computes per-replay
quality scores so "did the graph make product sense" is answered
numerically, not just structurally. Wave 2c lands these checks,
each producing a 0–1 score and a textual rationale:

- **topic purity** — share of pages in each workstream's topic
  cluster that are non-detour and non-ambient (Cloudflare / login
  / YouTube / interstitials drag the score down),
- **ambient containment** — share of ambient (YouTube /
  music / unrelated) pages correctly *not* attached to a focused
  workstream,
- **causal coherence** — share of copy/paste pairs whose source
  and destination both surface as endpoints of a dispatch /
  coding-session / opener / same-tab edge,
- **search→result→chat continuity** — share of recorded search →
  click → chat triples preserved as a connected path in
  Connections,
- **false-similarity rate** — fraction of strong similarity edges
  whose endpoints are in different recorded workstreams (lower is
  better),
- **ranking plausibility** — top-K ranked candidates per anchor
  page that share a recorded workstream with the anchor (higher
  is better; K is per-pack).

Scores are reported as a small table at the top of the markdown
report and as a structured block in the JSON sidecar. Thresholds
are advisory in v1 — they shift the report color (green / yellow /
red) but do not turn warnings into hard fails. Calibration
tightens as packs accumulate.

**Output.** Every replay run writes a markdown report (for humans)
and a JSON sidecar (for diffing) to a per-run folder under the
session pack's directory.

## 6. What's in v1 vs follow-up

**In v1, across four vertical slices:**

- *Wave 2a* — record + replay one browser at `captureLevel: minimal`,
  with the five-layer evaluator and the markdown + JSON report.
- *Wave 2b* — record + replay two browsers + relay; add
  `captureLevel: html` (opt-in).
- *Wave 2c* — first-class detour classifier, the qualitative-warning
  set above, **graph-quality scoring (R18)** as defined in §5, and
  `captureLevel: html+paste` (explicit flag).
- *Wave 2d* — `sidetrack-test` CLI wrapping the manual specs.

### CLI (Wave 2d) — surface

The CLI is a thin shell over the Playwright manual specs. Its job
is to spare the user from remembering env var names and spec paths.
v1 ships these subcommands; flag names are illustrative — Wave 2d
may rename them, but the surface stays this size:

| Subcommand | Purpose |
|---|---|
| `sidetrack-test record [--browsers 1\|2] [--capture-level minimal\|html\|html+paste]` | Spawn the record spec; print the session pack path on Ctrl-C. |
| `sidetrack-test replay <pack> [--hold] [--report-dir <path>]` | Replay a pack; print the report path. `--hold` keeps windows open for inspection. |
| `sidetrack-test report <run>` | Pretty-print an existing report (markdown to stdout) and surface diffs against the previous run for the same pack. |
| `sidetrack-test list` | List known session packs under `SIDETRACK_TEST_SESSIONS_DIR` with `recordedAt`, `mode`, last-replay status. |
| `sidetrack-test inspect <pack>` | Print pack metadata (no event bodies, no HTML) for sanity checks. |

The CLI does not introduce a new storage location, schema, or
runtime path — every subcommand maps to the corresponding manual
Playwright spec from 2a / 2b / 2c plus environment variables the
charter already names. Subcommand flags map directly onto the
`mode` block of `SessionPack` v1.

**Out of v1 (deliberately):**

- **No live-mode replay yet** — v1 ships two-browser-stubbed only;
  live and mixed modes are reserved for later waves but the
  schema's `mode` field is forward-compatible.

Also out of v1: screenshots; CI gating; cross-pack diffing UI;
sanitized-and-promoted public fixtures (per the brief's N2,
recorded packs are local-only; promotion to a committed fixture
is a separate manual step).

---

## `SessionPack` v1 — frozen schema

```ts
type SessionPack = {
  schemaVersion: 1;
  sessionId: string;          // ses_<ulid>
  recordedAt: string;         // ISO-8601 UTC
  sidetrackVersion: string;   // git sha or package version

  mode: {
    browsers: 1 | 2;
    captureLevel: "minimal" | "html" | "html+paste";
  };

  browsers: Array<{
    label: "A" | "B";
    activeWorkstreamId: string | null;
    events: SessionEvent[];
    snapshots: Record<string /* canonicalUrl */, HtmlSnapshot>;
  }>;

  expectations?: {            // hand-edited after first run
    expectedCanonicalUrls: string[];
    expectedEdges: Array<{ kind: string; from: string; to: string }>;
    knownDetours: string[];   // canonicalUrls or URL patterns
  };
};

type SessionEvent =
  | { kind: "navigation"; atMs: number; tabIdHash: string;
      url: string; canonicalUrl: string; title: string;
      transition: "activated" | "updated" | "closed";
      provider?: string }
  | { kind: "tabOpen" | "tabClose"; atMs: number; tabIdHash: string;
      openerTabIdHash?: string }
  | { kind: "focus" | "blur"; atMs: number; tabIdHash: string }
  | { kind: "workstreamSwitch"; atMs: number; workstreamId: string }
  | { kind: "copy" | "paste"; atMs: number; tabIdHash: string;
      contentHash: string;       // SHA-256 hex over `content`
      length: number;            // byte length of `content`
      content: string }          // raw text — always present at captureLevel "html+paste"
  | { kind: "dispatch"; atMs: number; dispatchId: string;
      workstreamId: string }
  | { kind: "feedback"; atMs: number; eventType: string;
      payload: unknown };

type HtmlSnapshot = {
  capturedAt: string;            // ISO-8601 UTC
  title: string;
  htmlRedacted: string;          // ran through the existing redaction helper
  redactionCounts: Record<string, number>; // categories matched
};
```

### Versioning rule

`schemaVersion` is the single source of truth for pack
compatibility. The reader must reject any pack whose
`schemaVersion` it does not recognize, with a clear error naming
the supported versions. New fields are additive within a
`schemaVersion`; renames or semantic changes require bumping it.

This mirrors the **Sync Contract v1 `payloadVersion`** convention
already used by `browser.timeline.observed` payloads — the same
discipline (explicit version, validated at the boundary, additive
within a version) applies here.
