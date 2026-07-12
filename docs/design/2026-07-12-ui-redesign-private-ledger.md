# Sidetrack UI Redesign — "Private Ledger"

- Status: **committed spec** (execute; do not relitigate the direction)
- Author: Design director synthesis
- Date: 2026-07-12
- Branch this lands on: `redesign/ui-foundation` (off `main` 8f80e908)
- Companion release plan: [`docs/plans/2026-07-12-sidetrack-1.0-felt-memory-release-plan.md`](../plans/2026-07-12-sidetrack-1.0-felt-memory-release-plan.md)
- Extension root: `packages/sidetrack-extension`; panel monolith:
  `entrypoints/sidepanel/App.tsx`; stylesheet:
  `entrypoints/sidepanel/style.css`

> This document is the single source of truth for the Sidetrack side-panel
> redesign. It answers the exact failure the user reported — *"i don't even
> see a privacy change"* — by making **privacy the design spine, not a
> badge**. It is organized so that Rollout §10 (R1) is a precise, testid-safe
> implementation contract the next agent executes without re-reading the
> whole panel.

---

## 1. Concept + design principles

### 1.1 Concept: PRIVATE LEDGER

The side panel reads as a **beautifully kept private field ledger**: quiet,
typographic, editorial, dense-but-calm. Nothing leaves the device, and the
panel *looks* like a private book of record — warm paper, ink, hairlines,
mono for the machine facts (domains, timestamps, counts). It is the visual
argument for the product's wedge: local, provable, yours.

There is **one living signature element**: the **CAPTURE LAMP**. An ambient
privacy indicator fused into a persistent header strip
(`lamp + current domain + capture verdict`), always visible in every view.
The lamp is not a widget you look *at*; it tints the panel's accent system,
so the *whole ledger* changes complexion by capture state. This is the
mechanical fix for the reported incident: a privacy change is now a
panel-wide, announced, glyph-labelled event — impossible to miss.

Lamp state → panel complexion:

| State | Trigger (single source of truth) | Accent | Glyph | Verdict copy | Affordances |
| --- | --- | --- | --- | --- | --- |
| **Recording** | `currentTabCaptureState === 'capturing'` | quiet warm ink accent (`--signal` family) | ● filled | `Recording this page` | capture affordances live |
| **Paused** | `captureOff` (master switch off) | amber (`--amber` family) | ⏸ | `Capture paused — everywhere` | capture affordances visibly quiesce (desaturate + `disabled`) |
| **Blocked here** | `currentSiteBlocked` (per-site no-capture rule) | rose (`--rose` family, **new token**) | ⊘ | `Not captured — rule: <label>` + rule chip | rule chip → Settings#no-capture-rules; capture affordances for *this page* quiesce |

The three states derive from **one existing correctness invariant** —
`currentTabCaptureState` at `App.tsx:4956`, which reuses the same
`firstMatchingNoCaptureRule` matcher the background capture gate uses
(URL-only, so the panel can never disagree with what is actually captured).
The redesign **reuses this derivation to drive the lamp** rather than
re-deriving it. Precedence is master-pause > per-site-rule > recording,
exactly as the invariant already encodes.

### 1.2 Design principles

1. **Privacy is the spine.** The capture verdict is the most prominent,
   always-visible, always-announced element. Three scattered zones
   (toolbar eye + card badge + status pills) collapse into one legible
   header spine.
2. **Name state honestly, once.** State is derived once (the tri-state
   invariant) and named by design. No per-incident patched ternaries; no
   "hidden" when we mean "deleted"; no "Indexing…" on a blocked page.
3. **Salience over counting.** Raw equal-weight counters caused the
   "93 topics" misread. Every count gets a salience layer: *actionable-now*
   (unread reply) is visually distinct from *ambient backlog* (unattributed
   inbox).
4. **Idle-silent.** No continuous/looping animation — the product has a
   100–144% CPU-runaway history. One-shot motion only. The idle panel does
   not paint.
5. **Tokens are the accent bus.** A full CSS-custom-property system carries
   color/space/type/radius/elevation/motion. The lamp retints *one* accent
   channel and the whole panel follows. No new hardcoded values.
6. **Local, provable, editorial.** Fonts bundled locally (never a CDN,
   never a runtime network fetch). Trust is *shown* (provenance, evidence
   tier, zero-outbound proof), not asserted.
7. **Progressive, not a rewrite.** Restyle and reorganize the chrome
   without rewriting feature internals. Every pinned testid, ARIA name,
   and load-bearing class survives unless the test changes in the same
   commit.

---

## 2. Token system (CSS custom properties — both themes)

All tokens live on `:root` (light "paper ledger") with a
`[data-theme='ink']` override block (dark "midnight vault"). This **extends
the existing `:root` block** (`style.css:1-43`) — it does not replace it.
The current palette already matches the direction; we add the missing
elevation, motion, space, and the **rose/blocked** channel, and we promote
the lamp accent to a single indirection layer.

### 2.1 The lamp accent indirection (new — the mechanism)

The lamp works by pointing three *semantic* accent tokens at the active
state family. Components consume **only** the semantic tokens; the lamp
swaps what they resolve to. This is what lets one state change retint the
whole panel.

```css
:root {
  /* Lamp accent bus — default = recording. Overridden per state on
     the panel root by [data-capture-state]. Components MUST consume
     these, never the state families directly. */
  --accent:        var(--signal);      /* primary accent ink        */
  --accent-2:      var(--signal-2);    /* hover / emphasis          */
  --accent-tint:   var(--signal-tint); /* fills, chips              */
  --accent-bg:     var(--signal-bg);   /* wash backgrounds          */
  --accent-on:     var(--paper-light); /* text/glyph on accent fill */
}

[data-capture-state='paused'] {
  --accent: var(--amber); --accent-2: var(--amber);
  --accent-tint: var(--amber-tint); --accent-bg: var(--amber-bg);
}
[data-capture-state='blocked'] {
  --accent: var(--rose); --accent-2: var(--rose-2);
  --accent-tint: var(--rose-tint); --accent-bg: var(--rose-bg);
}
```

`[data-capture-state]` is set on the panel root (`main.bac-app`) by an
App.tsx effect keyed off `currentTabCaptureState`. R1 wires this attribute
and the lamp; R2 migrates component rules from state families onto
`--accent*`.

### 2.2 Color tokens

Existing tokens (keep verbatim — already correct):
`--paper / -light / -tinted / -deep`, `--ink / -2 / -3 / -4`,
`--rule / -soft`, `--signal / -2 / -tint / -bg`,
`--amber / -tint / -bg`, `--green / -tint / -bg`, `--slate / -bg`.

New tokens (net-add):

| Token | Light "paper ledger" | Dark "midnight vault" | Purpose |
| --- | --- | --- | --- |
| `--rose` | `#b91c3c` | `#f2778d` | blocked-here accent ink (WCAG-AA on paper/ink) |
| `--rose-2` | `#e11d48` | `#fb7185` | blocked hover/emphasis |
| `--rose-tint` | `#fecdd3` | `#5c1f2b` | blocked fills/chips |
| `--rose-bg` | `#fff1f2` | `#2a1015` | blocked wash |
| `--signal-on` | `#fbf7ee` | `#15130f` | text on signal fill |
| `--amber-strong` | `#854d0e` | `#e0b155` | amber body text at AA on both themes |

Rationale: `--rose*` did **not** exist on `:root` (it lived only inside the
`.sx-health` scope). The blocked-here lamp state requires it, so it is
promoted to `:root` and given a dark override — closing the "capture states
would be color-only / rose is health-only" gap from the critique.

### 2.3 Space scale (new — replaces ad-hoc px)

The panel had no dedicated space scale (spacing borrowed the `--r*` radius
tokens, which double-booked meaning). Add a real 4px-based scale; keep the
`--r*` radius tokens for radius only.

```css
--space-0: 0;      --space-1: 2px;   --space-2: 4px;   --space-3: 8px;
--space-4: 12px;   --space-5: 16px;  --space-6: 24px;  --space-7: 32px;
--space-8: 48px;   --space-9: 64px;
```

`[data-density='compact']` tightens `--space-4..6` (mirrors the existing
compact radius overrides). R1 introduces the scale and uses it in the new
header/nav/card chrome only; existing rules migrate in R2.

### 2.4 Radius scale (consolidate the two overlapping scales)

Keep `--r1..--r8` (4→64) as the **canonical** radius scale. The parallel
`--rad-s/-m/-l` (4/6/10) is **deprecated**: alias them to `--r1/--rad-m/--r3`
now, retire the aliases in R2. No component reads a raw radius.

### 2.5 Type scale (see §3 for families)

```css
--type-display: 22px/1.15;   /* view titles, resume headline        */
--type-title:   16px/1.25;   /* section heads, card titles          */
--type-body:    14px/1.5;    /* body copy                           */
--type-meta:    12px/1.4;    /* meta, provenance                    */
--type-mono:    12px/1.4;    /* domains, timestamps, counters       */
--type-micro:   11px/1.3;    /* chip labels, eyebrows               */
```

### 2.6 Elevation (new — replaces inline rgba shadows)

No shadow tokens existed (shadows were inline `rgba()`). Add a 3-step
editorial-flat elevation system; ledger prefers hairlines over drop shadows.

```css
--elev-0: none;
--elev-1: 0 1px 0 var(--rule-soft);                    /* seams        */
--elev-2: 0 1px 2px rgba(27,25,22,.06),
          0 2px 8px rgba(27,25,22,.05);                 /* cards, pop   */
--elev-3: 0 4px 16px rgba(27,25,22,.10);                /* modals       */
```

Dark override multiplies the shadow rgba toward black
(`rgba(0,0,0,.4/.5)`). Modals/menus consume `--elev-3`; the persistent
header uses `--elev-1` as a bottom seam.

### 2.7 Motion (new — one-shot durations only)

Durations were hardcoded (200ms, 1.6s, 2s…). Tokenize; **no infinite
loops** (§7).

```css
--motion-fast:   120ms;   /* micro (chip on/off)          */
--motion-base:   200ms;   /* lamp cross-fade, panel settle */
--motion-reveal: 260ms;   /* staggered panel-open reveal   */
--ease-standard: cubic-bezier(.2,.0,.0,1);
--ease-out:      cubic-bezier(.16,1,.3,1);
```

`prefers-reduced-motion: reduce` collapses all of the above to `0ms` /
opacity-only, generalizing the existing `bac-app-settle` guard.

---

## 3. Typography plan

### 3.1 Families + roles

| Role | Family | Fallback stack | Used for |
| --- | --- | --- | --- |
| Display (editorial serif) | **Newsreader** | `'Source Serif 4', ui-serif, Charter, Georgia, serif` | view titles, resume headline, card titles |
| Body (refined sans) | **IBM Plex Sans** | `ui-sans-serif, system-ui, -apple-system, sans-serif` | body copy, buttons, menus |
| Mono | **IBM Plex Mono** | `ui-monospace, 'JetBrains Mono', SFMono-Regular, monospace` | domains, timestamps, counters, verdicts |

Design note: the panel today *names* Fraunces / Source Serif 4 / JetBrains
Mono but **ships zero font files** — everything falls back to
Georgia/ui-monospace. This redesign **bundles** an editorial serif for
display, a refined sans for body, and a mono. We move the display family
to **Newsreader** (a warmer, more editorial ledger voice than the old
Fraunces intent) and adopt **IBM Plex Sans** for body — a distinct sans
that reads as "field ledger," explicitly **not Inter**.

The `--display / --body / --mono` custom properties keep their names
(2551 `var()` usages depend on them); only their *values* change:

```css
--display: 'Newsreader', 'Source Serif 4', ui-serif, Charter, Georgia, serif;
--body:    'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, sans-serif;
--mono:    'IBM Plex Mono', ui-monospace, 'JetBrains Mono', SFMono-Regular, monospace;
```

### 3.2 Bundling plan (privacy-critical — no runtime network fetch, ever)

- **Format:** woff2 only, **latin subset only** (no latin-ext, no other
  ranges), variable where available to cut file count.
- **Location:** `packages/sidetrack-extension/public/fonts/` (served from
  the extension bundle, `@font-face src: url(/fonts/…)` — a
  chrome-extension:// URL, never remote). Honors the existing CSS comment
  at `style.css:11691` ("NO remote @import — MV3 CSP + offline").
- **Weights (minimize bytes):** Newsreader 400 + 600 (display + card
  title); IBM Plex Sans 400 + 500 + 600; IBM Plex Mono 400 + 500.
- **Budget:** total added woff2 ≤ **~400KB**. If any face pushes over
  budget, drop the 500 sans weight before the 600, and drop Newsreader 600
  before 400.
- **`font-display: swap`** so first paint uses the local fallback stack and
  never blocks; fallback metrics chosen to minimize reflow.
- **`@font-face` block** lives at the top of `style.css` (before `:root`
  consumers) or a dedicated `fonts.css` imported first.

### 3.3 Fallback contract (if bundling fails)

If a face fails to bundle under budget, fall back to a **curated LOCAL
stack — never a CDN, never Inter**:

- Display → `ui-serif, Charter, 'Source Serif 4', Georgia, serif`
- Body → `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`
- Mono → `ui-monospace, SFMono-Regular, Menlo, monospace`

The `--display/--body/--mono` fallback tails above already encode this, so
a failed bundle degrades silently to the curated stack with zero code
change beyond removing the `@font-face`.

---

## 4. Information architecture map

### 4.1 The persistent header (the spine — always visible, every view)

Replaces today's three scattered zones (`app-actions` eye at 6553,
`sp-status` pills at 6792, per-card badge at 7151) with one strip. Two rows
inside `app-head`:

**Row A — Capture Lamp strip** (net-new, `data-testid=capture-lamp-strip`):

```
[ ●lamp ]  research.google.com          Recording this page        [ 👁 eye ]
  glyph    current domain (mono)         verdict copy (glyph+text)   master switch
```

- **Lamp** — glyph + accent, `aria-hidden` visual; the verdict text carries
  the meaning (not color-only).
- **Domain** — `eTLD+1` of the focused/current tab, mono. Present in
  *every* view (today the domain only appears in the Now card). When no
  focused tab: `— no active tab`.
- **Verdict** — the state copy from §1.1, `role=status aria-live=polite` so
  every capture-state change is announced (fixes the inverted a11y
  priority: the only aria-live was the deeper-access banner).
- **Eye** — the master capture switch, **promoted out of the 11-icon row**
  to be the strip's primary control. Keeps `data-testid=capture-toggle`,
  `aria-pressed=captureEnabled`, `class` retains `capture-eye`.
- **Rule chip** — in blocked state, a chip `rule: <label>` →
  Settings#no-capture-rules (replaces the card's clickable blocked badge as
  the *primary* affordance; the card badge stays as a secondary,
  testid-stable echo — see §5.1).

**Row B — Nav + tools**:

```
[ Now  Work  Memory  Trust  Settings ]        [ search ] [ ⋯ ]  [ connect-dot ]
  primary sections (see 4.2)                    tools     overflow  quiet health
```

- **Search** — icon-button, opens the Search/Connections surface.
- **Overflow `⋯`** — `ToolbarOverflowMenu` (unchanged; testid
  `toolbar-overflow` + menuitem copy frozen).
- **Connect-dot** — the vault+companion+recall status, **quieted** into a
  single compound health dot with a hover/click popover that expands to the
  three tri-state pills (down/local-only/busy/connected). Steady-state =
  one calm dot + label; the three-domain distinction is preserved on
  expand, not deleted (per preserve-list). Error state stays legible (rose
  dot + text, routes to Settings#companion-connection).
- **Secondary capture tools** — screenshare-mask, find-active-tab,
  capture-mode toggle, coding-attach, capture-current-tab `+` — move into
  the overflow `⋯` menu / their contextual home (see runbook table §4.4).
  They **visibly quiesce** (desaturate + `disabled`) under paused/blocked
  via `[data-capture-state]`, systematizing the ad-hoc `disabled={captureOff}`.

### 4.2 Primary sections (5, replacing the 7-tab flat bar)

The 7 equal-weight tabs collapse to **5 salience-ranked sections**. Counts
gain a salience layer: *actionable-now* counts are accented; *ambient
backlog* counts are quiet mono.

| New section | Absorbs (old viewModes) | Salience |
| --- | --- | --- |
| **Now** | `now` + (R3) resume rollup | live context; no count |
| **Work** | `all` (Threads) + `workstream` + `queued` | Threads/Workstreams counts = quiet; **Queued-failed** = accented |
| **Memory** | `inbox` + `search`/`connections` | Inbox = quiet ambient; Search entered here |
| **Trust** | `inbound` + (R3) trust chips + provenance + zero-outbound proof | **Inbound unread = accented** (actionable, time-sensitive) |
| **Settings** | opens `SettingsPanel` (modal, unchanged) | — |

Within **Work** and **Memory**, sub-tabs (secondary tablist) switch between
the absorbed viewModes so no capability is lost and internal
`viewMode ===` routing is untouched. **Inbound** is elevated into **Trust**
because an unread AI reply is the highest-value felt-memory signal and must
not sit at equal weight with 762 ambient inbox visits.

> R1 builds the **nav shell** (the 5 primary sections + Now sub-slot) and
> keeps the current `viewMode` router behind it — see §10. R2 restyles the
> sub-tabs and per-surface bodies. R3 adds the resume rollup (Now), digest
> + trust chips (Trust).

### 4.3 Full surface → new location (nothing dropped)

| Inventoried surface | Old location | New home |
| --- | --- | --- |
| App shell / `app-head` | tabs + toolbar | **Header** (lamp strip Row A + nav/tools Row B) |
| Toolbar actions (eye/mask/find/search/+/mode/coding/⋯/gear) | `app-actions` | eye → lamp strip; search + ⋯ → Row B; mask/find/+/mode/coding → ⋯ menu / contextual; gear → **Settings** section |
| `ToolbarOverflowMenu` (⋯) | toolbar | Row B `⋯` (unchanged) |
| Status pill row (`sp-status`) | below tabs | Row B **connect-dot** popover (quieted, tri-state preserved) |
| Deeper-page-access banner | header + Inbox | banner slot under header (single banner system, §5.6); Inbox echo stays |
| System banners stack | mount 7703 | banner slot under header (unified `sys-banner`, §5.6) |
| Now current-tab card | `now` view | **Now** section (card head de-duped vs lamp — §5.1) |
| NowHistoryStrip | Now | **Now** section (breadcrumb; pin/restore invariant kept) |
| Recent Dispatches | Now only | **Now** section (Now-scoped, unchanged) |
| Threads view + rows | `all` | **Work** → Threads sub-tab |
| Workstreams view + bar/picker | `workstream` | **Work** → Workstreams sub-tab |
| Inbox view + InboxCard | `inbox` | **Memory** → Inbox sub-tab |
| AttributionBadge / PageEvidenceBadge / SuggestionStats | in cards | unchanged in their host cards (restyled R2) |
| NeedsOrganizeSuggestion | All-Threads inline | **Work** → Threads |
| Inbound view + InboundCard | `inbound` | **Trust** → Replies sub-tab (elevated salience) |
| Queued view | `queued` | **Work** → Queued sub-tab |
| Connections/Search shell + children | `connections`/`search` | **Memory** → Search/Explore sub-tab (shell internals unchanged) |
| PacketComposer | modal | modal (unchanged copy/testids) |
| DispatchConfirm / SafetyChainSummary | modal | modal (unchanged; SAFETY-CRITICAL) |
| ReviewComposer | modal | modal (unchanged) |
| Wizard | modal | modal (unchanged) |
| CodingAttach | modal | modal (unchanged) |
| SettingsPanel + NoCaptureRulesSection | modal | **Settings** section opens it; no-capture create/manage co-located (§5.4) |
| HealthPanel | modal (`Capture health`) | opened from ⋯ + **Trust** deep-link; internals **not** restructured this redesign (R2 merge point — §5.5) |
| WorkstreamDetailPanel + Checklist/LinkedNotes/Trust | modal | modal (unchanged; opened from Work) |
| TabRecovery | modal | modal (unchanged) |
| MoveToPicker | modal | modal (unchanged) |
| DesignPreview | dev modal | dev-only, opened from ⋯ (unchanged) |
| DejaVuPopover / DejaVuFullView | overlay + connections | overlay unchanged; full view in **Memory** → Search |
| Annotation / AnnotationOverlay | in-page + thread rows | unchanged |
| SendToDropdown / AutoSendQueueRow | dispatch helpers | unchanged (loops → one-shot, §7) |

### 4.4 Runbook-impact table (all 16 §13 capabilities reachable)

Every §13 step affordance stays reachable; only the *step description*
(where the user clicks) changes where the IA moved it. Testids unchanged.

| §13 step | Capability | Old path | New path | Description change? |
| --- | --- | --- | --- | --- |
| 1 | See capture state | scan eye + card badge + pills | **Header lamp strip** (always visible) | **Yes** — "look at the lamp strip" replaces "check the eye / card / pills" |
| 2 | Track current tab (manual) | toolbar `+` (hidden when auto) | ⋯ menu / Now card `+` | **Yes** — `+` now in ⋯ (or Now card); testid stable |
| 3 | Threads lifecycle buckets | Threads tab | **Work → Threads** | **Yes** — nav path only |
| 4 | Queue a follow-up + Queued | Queued tab | **Work → Queued** | **Yes** — nav path only |
| 5–6 | Workstream picker + create | Workstreams tab | **Work → Workstreams** | **Yes** — nav path only |
| 7 | Workstream-detail Checklist `N/M` | detail modal | modal (opened from Work) | No |
| 8 | Tab recovery reopen ↗ | recovery modal | modal (unchanged) | No |
| 9 | Inbound replied-N-min rows | Inbound tab | **Trust → Replies** (elevated) | **Yes** — nav path + salience |
| 10 | Review → Dispatch → Recent | thread row + Now | Work → Threads / Now | **Yes** — nav path only |
| 11 | PacketComposer redaction (preflightOutbound) | modal | modal (unchanged) | No — SAFETY-CRITICAL, must not regress |
| 12 | Coding-agent MCP handoff | coding-attach modal | modal (opened from ⋯) | **Yes** — entry moved to ⋯ |
| 13 | Export-to-vault path | detail / composer | unchanged | No |
| 14 | Search / recall | Search tab | **Memory → Search** | **Yes** — nav path only |
| 15 | Context pack compose+dispatch | Connections | **Memory → Search/Explore** | **Yes** — nav path only |
| 16 | Screenshare-mask + `[private]` masking | toolbar mask | ⋯ menu; masking unchanged | **Yes** — mask entry moved to ⋯ |

---

## 5. Per-surface redesign spec (states, copy, empty/error)

Each item below either **fixes** a critique item or **explicitly defers**
it with a reason.

### 5.1 Header lamp strip (fixes: scatter, no-domain, no-aria-live, quiesce)

- **States:** recording / paused / blocked (§1.1), each glyph + text +
  accent (never color-only).
- **Domain:** always shown, mono, eTLD+1; `— no active tab` when none.
- **Copy tone:** declarative, present-tense, plain. "Recording this page."
  / "Capture paused — everywhere." / "Not captured — rule: `<label>`."
- **aria-live:** verdict is `role=status aria-live=polite`; toggling the
  eye announces the new verdict. **Fixes the mechanical root of the reported
  incident.**
- **Quiesce:** paused/blocked sets `[data-capture-state]` on the panel root;
  a global rule desaturates + disables capture affordances — systematizing
  today's scattered `disabled={captureOff}`.
- **Card de-dup:** the Now card head no longer *owns* the verdict; the lamp
  does. The card keeps its tri-state badge **testids**
  (`capture-paused-badge`, `capture-blocked-badge`,
  `page-evidence-capture-badge`) as a **secondary echo** so app.test /
  e2e stay green, but visually it defers to the lamp and drops the
  redundant `captureDisabledReason` re-authored copy (the "same fact three
  times" critique). **R1** de-dups the head; the six-state ternary
  simplification (below) is **R2**.
- **Six-state ternary** (paused/blocked/indexing/not-indexed/evidence-tier/
  pending): **deferred to R2** — reason: it is feature-internal derivation,
  and R1's constraint is "restyle chrome without rewriting feature
  internals." R2 collapses it to lamp-verdict (capture) + evidence-tier
  (indexing) as two orthogonal, honestly-named slots.

### 5.2 Top-level IA / nav (fixes: flat counters, hidden mode-switch, no resume)

- **Salience counters:** actionable-now (Inbound unread, Queued-failed)
  accented; ambient (Threads/Workstreams/Inbox totals) quiet mono. Fixes
  "93 topics" misread and elevates the felt-memory signal.
- **Hidden Search/Connections mode-switch:** made explicit — Memory has a
  visible Search/Explore sub-tab instead of one tab covering two viewModes.
- **Resume rollup:** the missing headline felt-memory surface — **deferred
  to R3** (born in the new system, aligns with release-plan Wave 1 /
  Pillar 2). Reason: it depends on the companion's drain-lane materialized
  rollup (persistence through the sole-writer companion), which is Pillar-2
  build, not chrome. R1 reserves the Now section's top slot for it.

### 5.3 Current-tab card (fixes: verdict dup, cold-start dead-end, mixed jobs)

- **Verdict dup:** resolved by §5.1 (lamp owns verdict; card echoes testid).
- **No-focused-tab legibility:** with the lamp always showing domain +
  verdict, "No tracked tab in focus" no longer means zero capture
  legibility — the lamp still reads `— no active tab` / current verdict.
- **SuggestionStats cold-start dead-end** (`No signal yet · First time
  seeing this URL`): **fix in R2** by extending the *correct* page-access-off
  pattern (`SuggestionStats.tsx:105-134` — name the cause + one-click fix)
  to the cold-start branch: replace the "⇄ Graph scavenger hunt" with an
  action ("Attribute manually" / "This is new — file to a workstream").
  Reason for R2 not R1: it edits `SuggestionStats` internals + its test.
- **Mixed jobs** (attribution / capture / page-text / jump): **R2** groups
  the card into three visual bands (verdict — attribution — page-text) using
  the new space scale. R1 only de-dups the head.

### 5.4 Settings / privacy (fixes: "hidden" copy, no-confirm purge, theme default, co-location)

- **"Purged — … now hidden."** → **fix in R1-adjacent copy pass** (R2 for
  full section restyle): change to **"Purged — captured data for this site
  is deleted."** Reason it can move early: it is a one-string copy fix on a
  privacy-load-bearing surface; do it as part of the header/privacy R1
  commit if it does not touch pinned test copy (verify `InboxView`/settings
  tests don't assert the old string — they do not per the test map).
- **No-confirm purge:** add a confirm step ("Delete captured data for
  `<site>`? This cannot be undone." → Delete / Cancel) — **R2** (touches
  `NoCaptureRulesSection` internals; `purge-captured-data` testid stays).
- **Theme default `light` → `auto`:** restore **auto follows system** per
  the brief. **R1** flips `useState('light')` → the resolved-auto default
  **and** makes the toggle discoverable (Appearance is already in Settings;
  R1 ensures a first-run hint so dark-OS users aren't surprised — the exact
  reason it was disabled). The `matchMedia` resolver already exists and is
  preserved.
- **Dark-theme coverage:** the ink theme only remaps the base palette; 527
  hardcoded hexes + `.cx-`/`.hp-` rules aren't dark-aware. **R2** sweeps
  hardcoded hexes onto tokens (that is also what makes the lamp accent bus
  work). **HealthPanel dark coverage → R2 merge point** (§5.5).
- **No-capture create/manage co-location:** the ⋯ "Don't capture this site"
  create entry stays; **R2** adds a "Manage rules →" link from the same
  menu straight to Settings#no-capture-rules so create and manage aren't far
  apart.

### 5.5 HealthPanel (explicitly NOT restructured this redesign)

- **Deferred wholesale to R2** as a **merge point.** Reasons: (1) a
  concurrent branch just added a **section-15 rail** to HealthPanel — R1
  must not conflict with it; (2) HealthPanel is a *second* design system
  (`.sx-health`, 253 rules, its own token block deliberately off `:root`)
  and its testids/class-names (`.sx-alarm.amber`/`.signal`,
  `hp-pipeline-stage-*`, `hp-overall-status`) are heavily pinned by
  `pipeline.test.tsx` + `switchboard-v2.spec`.
- **R2 plan:** reconcile the two design systems by having `.sx-health`
  *consume* the `:root` tokens (including the lamp accent bus and the new
  rose token, which it already defines locally) and adding the missing
  dark-mode overrides — **without** renaming a single `.sx-*` class or
  testid, and rebased on top of the section-15 rail.

### 5.6 Banners (fixes: two banner systems, inverted a11y)

- Unify `sys-banner` (status) and the `banner warning`/`sp-banner` (offers)
  visual languages into **one** banner component with tone variants
  (green/amber/yellow/rose/signal) consuming tokens. **R2** (touches
  `SystemBanners` + deeper-access banner). R1 note: the header's *only*
  aria-live is no longer the deeper-access banner — it's the capture
  verdict (§5.1), correcting the inverted a11y priority immediately.

### 5.7 Connections / Search shell (largest surface)

- **No structural change any wave** beyond re-skin. Reason: 680 `.cx-`
  rules + the densest testid set (unit + e2e). **R2** migrates `.cx-` colors
  onto tokens for dark-mode + lamp-accent consistency; the 3-column shell,
  every `connections-*` / `focus-*` / `flow-*` testid, and all mode tabs
  stay byte-identical.

---

## 6. Motion + accessibility rules

### 6.1 Motion (idle-silent; one-shot only)

- **Ban all `infinite` keyframes.** The 8 looping animations
  (`pulse-glow`, `thread-autosend-pulse`, `icon-btn-pulse`, `ws-name-pulse`,
  `thread-dot-pulse-amber`, `thread-dot-pulse-signal`, `sx-pulse`,
  `cx-spinner-pulse`) are converted to **one-shot** (single fade/scale on
  state-change) or removed. Convert in the wave that owns each surface;
  **R1 owns the lamp cross-fade** (`--motion-base` ~200ms, one-shot) and the
  header. Loading spinners become a single static glyph + `aria-busy`
  (no perpetual spin).
- **Panel-open reveal:** generalize the existing one-shot `bac-app-settle`
  (200ms) into a **staggered reveal** (`--motion-reveal`) of header → nav →
  body, one-shot, reduced-motion-guarded.
- **Lamp cross-fade:** ~200ms opacity/accent cross-fade on capture-state
  change; never loops.
- **CPU guard:** no `setInterval`-driven animation; the idle panel must not
  paint (per the runaway history + preserved perf guards: 4s poll,
  cached companion status, `COMPANION_FETCH_MAX_CONCURRENCY`).

### 6.2 Accessibility

- **Lamp not color-only:** every state = glyph + text + accent. WCAG **AA**
  contrast for `--accent`/`--rose`/`--amber` body text on **both** themes
  (rose/amber tuned in §2.2 for this).
- **aria-live:** capture verdict is `aria-live=polite`; state changes
  announce. This is *the* a11y fix.
- **Focus:** visible focus ring on every interactive header element; the
  eye/lamp reachable by keyboard; tab order = lamp strip → nav → body.
- **ARIA names frozen:** `role=main` name **"Sidetrack workboard"** stays;
  every tab's accessible name stays (`Now`, `Threads`, `Inbox`, …) even as
  the *visual* grouping changes — the primary sections keep the old
  viewMode tabs' ARIA names on their controls where tests pin them (§10.4).
- **Dark/light:** default follows system (`auto`); both themes meet AA.

---

## 7. Legacy / cleanup ledger (drives R2)

| Debt | Where | Wave |
| --- | --- | --- |
| 527 hardcoded hex → tokens | `style.css` | R2 (unblocks lamp accent + dark) |
| Two radius scales | `--r*` vs `--rad-*` | R2 (retire `--rad-*` aliases) |
| 8 infinite animations | `style.css` | per-surface, most in R2; lamp in R1 |
| Inline `rgba` shadows | App.tsx + css | R2 (→ `--elev-*`) |
| Two design systems | `.cx-`/main vs `.sx-health` | R2 (health consumes `:root`) |
| Six-state capture ternary | `App.tsx:7146` | R2 (honest two-slot) |
| "hidden" purge copy | `NoCaptureRulesSection.tsx:97` | R1-copy / R2-confirm |

---

## 8. Rollout

### R1 — Foundation (THIS workflow) — see §10 for the contract
Tokens + fonts + header/lamp + nav shell + current-tab card head de-dup +
theme-default-auto. Testid-safe, no feature-internal rewrites.

### R2 — Per-surface restyle + legacy retirement
Migrate hardcoded hex → tokens; retire duplicate radius scale; convert
remaining infinite animations to one-shot; unify banners; collapse the
six-state capture ternary; fix SuggestionStats cold-start dead-end; add
purge confirm; restyle Threads/Work/Memory/Trust bodies + sub-tabs;
reconcile HealthPanel `.sx-health` onto `:root` **rebased on the concurrent
section-15 rail**; dark-mode sweep incl. `.cx-`/`.hp-`. Retire legacy CSS.

### R3 — Felt-memory surfaces (release-plan Wave 1 / Pillar 2)
Born in the new system: **resume rollup** (Now top slot, drain-lane
materialized, restart-persistent, <200ms, no per-open recompute); **digest**
(calm opt-in cadence, idle/drain lane, no hot timer); **trust chips**
(15 REASON_CODES → plain language + evidence-tier badge) in **Trust**;
zero-outbound network-trace proof surface in **Trust**.

---

## 9. Constraints honored (R1)

- Progressive: restyle/reorganize the top chrome **without** rewriting
  feature internals.
- DOM/testids tests pin stay stable unless the test changes in the **same**
  commit.
- **HealthPanel internals not restructured this wave** — noted as an R2
  merge point behind the concurrent section-15 rail.

---

## 10. R1 IMPLEMENTATION CONTRACT (precise — the next agent executes this)

**Scope:** tokens + fonts + header/lamp + nav shell + current-tab card head
de-dup + theme default. **One commit** (or a tight series), tests green,
typecheck clean.

### 10.1 In scope

1. **Tokens** (`style.css` `:root` + `[data-theme='ink']`): add the lamp
   accent bus (§2.1), `--rose*`/`--signal-on`/`--amber-strong` (§2.2), the
   `--space-*` scale (§2.3), `--elev-*` (§2.6), `--motion-*` + eases (§2.7),
   `--type-*` (§2.5). Alias `--rad-*` → `--r*` (do **not** delete callers).
   **Do not** touch the 527 hardcoded hexes (R2).
2. **Fonts** (`public/fonts/` + `@font-face`): bundle Newsreader / IBM Plex
   Sans / IBM Plex Mono woff2 latin subsets ≤ ~400KB, `font-display: swap`;
   point `--display/--body/--mono` at them with the curated fallback tails
   (§3). No remote fetch. If any face busts budget, apply §3.2 drop order.
3. **`[data-capture-state]` wiring:** App.tsx effect sets
   `data-capture-state` on `main.bac-app` from the existing
   `currentTabCaptureState` (`App.tsx:4956`) — **reuse, do not re-derive.**
4. **Header lamp strip** (Row A): new `capture-lamp-strip` with lamp glyph +
   domain (eTLD+1) + verdict (`role=status aria-live=polite`) + the eye.
   **Move** the existing eye button into the strip **keeping** its
   `data-testid=capture-toggle`, `aria-pressed`, `capture-eye` class, and
   ON/PAUSED title copy. Blocked state renders the rule chip →
   Settings#no-capture-rules.
5. **Nav shell** (Row B): render the 5 primary sections. **Keep the current
   `viewMode` router intact** behind them (Work/Memory host secondary
   sub-tabs that set the old viewModes). Search icon + `⋯`
   (`ToolbarOverflowMenu`, unchanged) + connect-dot (quieted `sp-status`
   folded into one dot+popover; tri-state preserved). Secondary capture
   tools (mask/find/+/mode/coding) relocate into `⋯` / contextual, keeping
   their testids/labels, and quiesce via `[data-capture-state]`.
6. **Current-tab card head de-dup:** the card defers the verdict to the lamp
   and drops the re-authored `captureDisabledReason` prose, **but keeps**
   `focused-tab-attribution`, `now-page-kind`, `capture-paused-badge`,
   `capture-blocked-badge`, `page-evidence-capture-badge`,
   `capture-pending-suffix`, `current-tab-page-content-card`,
   `current-tab-summary-toggle` and their text where tests assert them.
7. **Theme default → auto:** `App.tsx` `useState<ThemeMode>('light')` →
   `'auto'` (resolver already handles it); add a one-time first-run hint so
   dark-OS users aren't surprised. jsdom guard already present — keep it.
8. **Lamp motion:** one-shot ~200ms cross-fade (`--motion-base`),
   reduced-motion-guarded. **No** new infinite animation.
9. Optional low-risk copy fix: purge "hidden" → "deleted" (only if no
   pinned test asserts the old string — it does not).

### 10.2 Out of scope for R1 (do NOT do)

- Restructuring HealthPanel (R2 merge point behind the section-15 rail).
- Touching Connections/Search shell internals or its testids.
- The 527 hardcoded-hex sweep; the six-state ternary collapse; the
  SuggestionStats cold-start fix; banner unification; purge confirm dialog.
- Renaming/removing any pinned testid, ARIA role+name, or load-bearing class.

### 10.3 Testids / classes that MUST stay stable (R1 tripwires)

`capture-toggle` (+ `capture-eye` class), `focused-tab-attribution`,
`now-page-kind`, `capture-paused-badge`, `capture-blocked-badge`,
`page-evidence-capture-badge`, `capture-pending-suffix`,
`current-tab-page-content-card`, `current-tab-summary-toggle`,
`toolbar-overflow` (+ menuitem copy: `Capture health`, `Dump panel state`,
`Design preview`), `dump-result`, `deeper-access-banner`, `now-history-strip`
+ `now-history-chip-<idx>`, `ws-picker-row` (class), `thread-row-dot-<class>`,
and every `connections-*` / `focus-*` / `flow-*` testid (untouched by R1).

### 10.4 ARIA names that MUST stay stable

`role=main` name **"Sidetrack workboard"**; every current tab's accessible
name — `Now`, `Threads`, `Workstreams`, `Inbox`, `Inbound replies`,
`Queued follow-ups`, `Search`. Where a primary section absorbs multiple old
tabs, the section's sub-tab controls keep those exact accessible names so
`getByRole('tab', { name })` assertions in `app.test.tsx` pass. If any tab
accessible name must change, the assertion in `tests/unit/app.test.tsx`
changes in the **same** commit.

### 10.5 Verification (R1)

```
cd packages/sidetrack-extension && PATH="$HOME/.bun/bin:$PATH" bunx --no-install vitest run \
  tests/unit/app.test.tsx \
  tests/unit/toolbarOverflowMenu.test.tsx \
  tests/unit/tabsession/InboxView.test.tsx \
  tests/unit/tabsession/InboxCard.test.tsx \
  tests/unit/tabsession/SuggestionStats.test.tsx
```
Plus the package typecheck script. E2E (capture-gate / wizard-flow /
tracking-mode) are the outer tripwire — must stay green.

---

## 11. Preserved invariants (do not regress)

- Tri-state capture derivation (`App.tsx:4956`, URL-only matcher) is the
  **single source of truth** for the lamp — reused, never re-derived.
- SuggestionStats page-access-off pattern (cause + one-click fix) is the
  template to **extend**, not lose.
- Token foundation + `[data-theme='ink']` remap + `[data-density='compact']`
  + `prefers-color-scheme` resolver + one-shot `bac-app-settle` — **build
  on**, don't rewrite.
- Perf guards: 4s poll, cached companion status across mounts,
  `COMPANION_FETCH_MAX_CONCURRENCY=4` — must survive.
- NowHistoryStrip pin/restore **never auto-switches the browser tab**.
- Connection-status tri-state (down/local-only/busy/connected, not
  color-only) — quieted, **not deleted**.
- Purge plumbing (`purgeNoCaptureRule` tombstone route) — keep the
  mechanism; only fix copy (R1) + add confirm (R2).
- PacketComposer redaction via `preflightOutbound` (§13 step 11) —
  SAFETY-CRITICAL, untouched.
