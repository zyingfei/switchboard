# Sidetrack MVP — Designer Mock Prompts

> **Product name**: Sidetrack (locked 2026-04-26). Workstream-tree
> examples in mocks below intentionally use "Switchboard" as the
> user's example workstream name — that's preserved from the napkin's
> worked example, not a product reference.

**Created**: 2026-04-26
**Source of truth**:
- PRD §6 (P0 + P0.5 surfaces) — see PR #11 (`prd/switchboard-mvp-v1`)
- BRAINSTORM.md anchors §23.0, §24.10, §27, §27.6, §28
- Visual baseline: `bac-design-spec.html` (poc-planning copy at `imports/bac-design-spec.html`, also at `/Users/yingfei/Downloads/bac-design-spec.html`)

**How to use**: paste the **Designer brief** below at the top of any mock
prompt before sending to a designer (Figma, design-AI like Galileo, or
human). Each Mock 1–14 below is self-contained and references the same
brief.

---

## Designer brief (paste at the top of any prompt)

> You're designing the MVP UI for **Sidetrack** — a Chrome MV3 side
> panel + Node companion that tracks active AI work across providers
> (ChatGPT, Claude, Gemini, Codex), lets users reorganize it manually,
> queue follow-ups, recover lost tabs, and dispatch context to other
> AIs. Visual baseline is `bac-design-spec.html` — extend it; don't
> restart. Design tokens locked: **paper** `#F5EFE2`, **ink**
> `#1B1916`, **signal-orange** `#C2410C` (reserved for live signals
> only — unread reply, active workstream, déjà-vu), **Fraunces** for
> display, **Source Serif 4** for body, **JetBrains Mono** for
> IDs/paths/technical data. **Italic serif = the system speaking**
> (captured quotes, helpers); **mono = identifiers**. Side panel is
> ~400px wide; assume scrollable single column. **Privacy model
> (locked 2026-04-26)**: per-workstream `private`/`shared`/`public`
> flag is the substantive control (P0); workstreams flagged `private`
> render with masked titles `[private]`. Auto-detect-on-screen-share
> via `getDisplayMedia` is deferred to P1 — design these mocks for
> the privacy-flag trigger only.

---

## Mock 1 — Side-panel workboard, top-level (P0)

**Surface**: main side panel, default view.

**Design**: a single scrollable column with six stacked sections, all
visible by default, each collapsible:

1. **Current Tab** — if user's active tab is tracked, show title
   (italic serif if assistant-generated), provider chip, status
   (signal-orange dot if unread reply; amber for "needs action"; gray
   for stale), workstream breadcrumb, action row:
   `Locate · Stop · Queue · Packet`.
2. **Active Work** — workstreams flat-list with counts (e.g.,
   `Switchboard / MVP PRD — 3 threads · 2 queued · 1 closed`). Click
   expands inline to Mock 2.
3. **Queued (outbound)** — pending follow-ups grouped by target.
   Status pill: pending / ready / sent.
4. **Inbound** — tracked threads with new assistant turns since last
   visit. Pulse-signal-orange dot. Relative time
   ("Claude replied 3 min ago").
5. **Needs Organize** — Inbox/Misc items the user hasn't placed yet.
   Subtle, not alarming.
6. **Recent / Search** — search input + recent-touched list with
   relative timestamps and provider chips.

**States**: empty (first-run, only Inbox visible), loaded (default),
screen-share-safe (titles masked to `[private]`), companion-down (red
badge in header, sections grayed). Header always shows: vault:
connected · companion: status pill · `[settings]`.

---

## Mock 2 — Workstream detail (expanded view, P0)

**Surface**: when user expands a workstream from Mock 1, the view
replaces the section in-place.

**Design**:
- Breadcrumb at top (`Switchboard / MVP PRD / Active Workstreams`);
  each segment clickable.
- Workstream metadata row: kind (project / cluster / subcluster), tags
  (chips), created/updated timestamps in mono.
- **Tracked items list** — chats, searches, coding sessions, packets,
  mixed; each row shows type icon, title, provider chip, last-seen
  relative time, primary-link count.
- **Manual checklist** (collapsible, default open if non-empty) —
  checkbox list, plain `[+] Add item` at bottom. Ticked items strike
  through. Pure UI; no automation.
- **Queued asks** for this workstream (subset of Mock 1 §3, scoped).
- **Subclusters** as nested workstream rows (recursive — same Mock 2
  layout).
- Footer action row:
  `New subcluster · Add tag · Move to… · Generate packet · Export`.

**Constraints**: items move via drag (Mock 4) or "Move to…" picker.
Identity is `bac_id` — moves never break links.

---

## Mock 3 — Tab recovery dialog (P0)

**Surface**: modal opened from the side panel when user clicks "Reopen"
on a tab marked `closed (restorable)`.

**Design**: small centered modal with the captured `TabSnapshot`:
- Title (italic serif if AI-generated)
- Provider + URL (mono, truncated)
- Last active relative time + "captured at" timestamp
- Three vertically stacked action buttons in priority order:
  1. **Focus open tab** (if Chrome reports tab still open — hide
     otherwise)
  2. **Restore session** (if recently closed and `chrome.sessions` has
     it)
  3. **Reopen URL** (always available)
- Status line below: which strategy will run if user clicks the
  primary button.

**States**: all three available; only "reopen URL" available; failure
("couldn't restore — opening URL instead").

---

## Mock 4 — Reorganize / move-item UX (P0)

**Surface**: drag-and-drop in workboard, plus "Move to…" picker
fallback.

**Design**:
- **Drag**: dragging a tracked item shows a ghost row with title; drop
  targets in workstream tree highlight on hover (signal-orange edge,
  no fill).
- **Picker**: "Move to…" opens a modal with workstream tree as
  collapsible list; type-to-filter input at top; create-on-the-fly:
  typing a path that doesn't exist surfaces
  "Create new: `Switchboard / MVP / X`".
- After move: brief toast `Moved to <path>` with `[Undo]` action; tab
  item's primary breadcrumb updates in-place.

**Constraints**: identity preserved by `bac_id` — file paths/folder
names are projections only. Reorganization is the normal state, not
error recovery; expect users to do this multiple times per session.

---

## Mock 5 — Packet composer (P0)

**Surface**: modal opened from "Generate packet" action (workboard,
workstream detail, or current-tab actions).

**Design** (single composer, three packet kinds via template selector):
- **Header**: packet kind selector
  (`Context Pack` · `Research Packet` · `Coding Agent Packet` ·
  `Notebook Export`).
- **Template selector** (when kind = Research Packet):
  `web-to-AI checklist` · `resume tech-stack` ·
  `latest developments radar` · `custom`.
- **Scope picker** (multi-select tree from current workstream context):
  workstream subtree, individual tracked items, queue items,
  link-neighborhood depth slider (0–2).
- **Target picker** (when applicable): GPT Pro · Deep Research ·
  Claude · Gemini · Codex · Claude Code · Cursor · Markdown.
- **Live preview pane** (right side, scrollable): rendered Markdown
  output as user adjusts scope.
- **Token estimate** in mono at bottom (e.g.
  `4,200 / 32,000 tokens`); turns amber > 80%, signal-orange > 100%.
- **Redaction summary** in italic serif at bottom:
  `Redacted 2 items: 1 email, 1 GitHub token` with `[reveal]` toggle.
- **Footer**: `[Cancel]` · `[Copy to clipboard]` · `[Save to vault]` ·
  primary `[Dispatch]` (only enabled if target selected and dispatch
  is allowed; routes to Mock 6).

---

## Mock 6 — Dispatch confirm + safety chain (P0, ship-blocking per §24.10)

**Surface**: full-screen overlay (or large modal) when user hits
`[Dispatch]` from Mock 5 or Mock 7.

**Design** (extend the existing `Confirm dispatch` mock in
`bac-design-spec.html`):
- **Top banner**: target provider + thread (e.g.,
  `→ ChatGPT · new chat`).
- **Redaction notice** (italic serif): list of fired rules with
  `[reveal]` per item; signal-orange tint if any.
- **Token budget**: bar with `tokens / model context window`;
  signal-orange pulse if over.
- **Privacy check**: signal-orange warning if any source workstream
  in the packet is flagged `private` — "this packet draws from a
  private workstream; confirm intent before dispatch." (Auto-detect
  via `getDisplayMedia` is P1; for v1, the privacy-flag check is the
  substantive guard.)
- **Final preview**: collapsible rendered packet content.
- **Mode selector**: `Paste-mode (default)` · `Auto-send` (auto-send
  disabled by default per §24.10; tooltip explains "opt-in per
  provider").
- **Action row**: `[Cancel]` · `[Edit packet]` · primary
  `[Confirm dispatch]`.

**States**: clean (all green, no warnings), redaction-fired,
token-overflow, screen-share-active,
auto-send-not-enabled-for-this-provider.

---

## Mock 7 — Inline review composer (§28, P0)

**Surface**: triggered when user selects span(s) of an assistant turn
in a tracked tab; composer opens in the side panel as an overlay over
the workboard.

**Design**:
- **Span snippets** at top: each captured span shown as italic-serif
  blockquote with provider + capturedAt in mono.
- **Per-span comment** input: small textarea below each snippet.
- **Overall reviewer note** (multi-line textarea below all spans).
- **Verdict picker**: pill buttons — `agree (green)` ·
  `disagree (signal-orange)` · `partial (amber)` ·
  `needs-source (slate)` · `open (gray)`. Single-select.
- **Action row** (bottom):
  - `[Save review only]` (no dispatch — just records `ReviewEvent`)
  - `[Submit-back to {provider} thread]` (composes follow-up turn into
    the same chat; routes to Mock 6)
  - `[Dispatch to…]` (opens target picker → Mock 6)
- **Status line**: "Saving review will be visible later in
  `_BAC/reviews/` and in déjà-vu surfacing."

**Note**: this is distinct from the Packet composer (Mock 5). Reviews
annotate a captured turn; packets bundle context for handoff.

---

## Mock 8 — First-run wizard (P0)

**Surface**: full-side-panel takeover at first install; ~5 sequential
steps.

**Design** (each step is one panel-height; bottom shows progress dots
and `[Back] [Next]`):
1. **Welcome** — name, one-line value prop, "skip tour" link.
2. **Companion install path picker** — two cards side-by-side:
   - `npx @sidetrack/companion` (HTTP loopback — locked per ADR-0001;
     this is the only option in v1; Native Messaging considered and
     rejected). Step shows install snippet to copy/paste plus a live
     "waiting for companion…" check that turns green when reachable.
3. **Vault folder picker** — large `[Choose folder]` button (triggers
   `showDirectoryPicker()`); shows picked path in mono once selected;
   surfaces "Local REST API plugin detected — will use surgical PATCH"
   if present (italic serif), "not detected — will use plain
   filesystem (you can install later for speed)" if not.
4. **Provider permission grant** — list of supported providers
   (ChatGPT, Claude, Gemini, Codex web) with toggle each; explanation
   that auto-tracking can be disabled per-site later.
5. **Done** — "You're set up. Open any AI chat tab to start tracking.
   Side panel pinned to your toolbar."

**Constraint**: companion install is what makes silent capture work.
Wizard explains *why* (sentence in italic serif: "Without the
companion, captures pause when Chrome is idle."); no jargon about MV3
or service workers.

---

## Mock 9 — Settings (P0)

**Surface**: settings page within side panel (gear icon in header →
opens full-panel settings).

**Design**: sectioned scrollable list:
- **Tracking**: global auto-track toggle; per-site list with toggle +
  remove; default behavior ("auto-track new providers" on/off).
- **Privacy**: per-workstream `private` / `shared` / `public` flag
  picker (default `private` for new workstreams; user promotes with
  intent); redaction rules list (built-in + user-added; add-rule
  action). Note: screen-share-safe auto-detect is P1; for v1 the
  privacy flag is the substantive control.
- **Companion**: status pill (running / disconnected / error); install
  path; vault folder (re-pick action); restart hint.
- **Packets**: default target per provider; auto-download toggle
  (default on for project-tier workstreams, off for root/Misc).
- **Dispatch**: paste-mode default (locked, with tooltip explaining
  §24.10); per-provider auto-send opt-in toggles (off by default).
- **MCP**: server status (running per client); audit log link;
  tools-list link (read-only enumeration).
- **About**: version, vault path, companion path, links to docs.

---

## Mock 10 — System states (P0 ship-blocking)

**Surface**: badges and banners that overlay the workboard.

**Design** (as a single mock showing each state):
- **Companion-disconnected**: red badge top of side panel
  `Companion: disconnected · 12 items queued`. Workboard sections
  grayed but readable from hot cache. `[Retry]` action.
- **Vault-unreachable**: amber banner below companion badge
  `Vault: error — re-pick folder?` with `[Re-pick]` action.
- **Provider-broken (selector failure)**: yellow banner inside the
  affected workstream row `ChatGPT extractor health: 4/10 recent
  captures clean — clipboard fallback active`. `[Queue diagnostic]`
  action.
- **Screen-share-active**: subtle signal-orange banner at top
  `Screen-share active — content masked`. Tracked-item titles render
  as `[private]`.
- **Captured-page injection detected** (during packet compose):
  inline warning under the source `This source contains content that
  looks like a prompt-injection attempt. Wrapped in <context> markers
  automatically.`

---

## Mock 11 — Private-workstream masked workboard (P0, extends design spec)

**Surface**: same as Mock 1, but rendering only items in workstreams
flagged `private`. Triggered by per-workstream privacy flag (P0); the
auto-detect-on-screen-share trigger is P1 (deferred per Q6) and not
designed in this mock.

**Design** (extend `bac-design-spec.html`'s screen-share-safe section
visually — the masked layout is the same; the trigger is what
changed):
- All tracked-item titles → `[private — workstream item]` (italic
  serif).
- Provider chips remain visible (so user knows the layout).
- Workstream names → masked except for `private`/`shared`/`public`
  per-workstream flag (shared/public stay visible; private redacts).
- Queue text → `[private — N items queued]`.
- Inbound count remains as count without titles.
- Side-panel header: signal-orange `Screen-share active — content
  masked` strip.
- Settings: explicit toggle to disable masking (with confirmation).

---

## Mock 12 — Coding session attach modal (P0.5)

**Surface**: modal opened from "Attach coding session" action on a
workstream.

**Design**:
- **Form fields** (mono inputs for technical fields):
  - Tool (radio): Codex · Claude Code · Cursor · JetBrains · Other
  - cwd (mono input, with `[browse]` action)
  - branch (mono input, optional)
  - sessionId (mono input)
  - name (italic serif input — human-readable)
  - resumeCommand (mono multi-line input; auto-detect helper for
    known tools that says "we can resume this with `claude resume
    <sessionId>` — confirm?")
- **Preview**: shows the eventual side-panel row appearance.
- **Action row**: `[Cancel]` · `[Attach]`. After attach: side panel
  scrolls to the workstream and highlights the new session row, which
  has an `[Open in {tool}]` button that runs the resume command.

---

## Mock 13 — Inbound reminder + Recent dispatches (P0 + P0.5)

**Surface**: two related views in the workboard (Mock 1 §4 and a new
view).

**Design**:
- **Inbound reminder card** (in Mock 1 §4): pulse-signal-orange dot ·
  provider chip · thread title (italic serif if AI-generated) ·
  "replied X min ago" · `[Open]` · `[Dismiss]` · `[Mark relevant]`
  (the last attaches to a workstream if not already).
- **Recent dispatches view** (P0.5; opens from a "Dispatches" link in
  the workboard footer or via menu): chronological list of
  `DispatchEvent`s. Each row: source item (small chip) → arrow →
  target (provider chip + thread title) · status pill (`sent` gray /
  `replied` signal-orange / `noted` green / `pending` amber) ·
  relative time. Click row to focus the source or open the target.

**Note**: when a dispatched-out chat receives a reply, the dispatch
row's status flips to `replied` and a corresponding inbound reminder
fires. These two views are paired.

---

## Mock 14 — Lightweight annotation capture (P0.5)

**Surface**: small popup or side-panel composer when user selects text
on a web page and triggers Sidetrack (right-click menu or keyboard
shortcut).

**Design**:
- **Top**: captured selection in italic serif blockquote.
- **URL + page title** in mono below.
- **Note input** (multi-line, italic-serif placeholder
  "Why are you saving this?").
- **Workstream picker** (default = active workstream of current tab,
  or Inbox).
- **Action row**: `[Save to Inbox]` · `[Save to {workstream}]`.

**Constraint**: this is the **input** side of §28 inline review (the
captured annotation can later be opened in Mock 7's composer).
Persistent overlay (hovering highlights on revisit) is **P1**,
deferred.

---

## Intentionally NOT in this set (deferred per PRD §6.5)

- Provider-history scrape view (P1 — when tab recovery falls back
  beyond reopen URL)
- Smart-recall / vector-search UI (P1 — lexical search in Mock 1 is
  enough for MVP)
- MCP host panel (user-installed servers list + dispatch from side
  panel) — P1, separate mock when that surface lands
- Persistent web annotation overlay — P1
- Custom Obsidian graph UI — never (Obsidian native handles it)
